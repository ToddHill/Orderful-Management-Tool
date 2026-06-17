/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/runtime', 'N/file', 'N/record', 'N/https', 'N/log', 'N/email', 'N/search'], (runtime, file, record, https, log, email, search) => {
    /**
     * getInputData: loads the JSON payload file and returns an array for map stage
     */
    const getInputData = (context) => {
        const script = runtime.getCurrentScript();
        const fileId = script.getParameter({ name: 'custscript_processing_file_id' });
        if (!fileId) throw new Error('Missing custscript_processing_file_id parameter');

        const f = file.load({ id: parseInt(fileId, 10) });
        const contents = f.getContents();
        const parsed = JSON.parse(contents || '{}');

        // Try common collection properties, fall back to array or single object
        let items = parsed.transactionSets || parsed.transactions || parsed.items || parsed.lines || null;
        if (!items) {
            if (Array.isArray(parsed)) items = parsed; else items = [parsed];
        }
        return items;
    };

    /**
     * map: receives each item and creates a stub NetSuite record for later mapping
     */
    const map = (context) => {
        try {
            const value = JSON.parse(context.value);
            // Expected input: a LIN_loop entry representing an item with ZA_loop destinationQuantity arrays
            // We'll create one customrecord_pos_852_processing per store/line combination with aggregated quantities

            // Helper: find item UPC
            const itemIdUpc = (value.itemIdentification && value.itemIdentification[0] && (value.itemIdentification[0].productServiceID2 || value.itemIdentification[0].productServiceID1)) || null;

            // Aggregate quantities per store
            var grouped = {}; // key: store
            var startDate = null;
            var endDate = null;
            try {
                // try to pull dates from context: no direct access here; we'll leave dates null for now
            } catch (e) {}

            var lin = value;
            if (lin.ZA_loop && Array.isArray(lin.ZA_loop)) {
                lin.ZA_loop.forEach(function(za) {
                    var activityCode = (za.productActivityReporting && za.productActivityReporting[0] && za.productActivityReporting[0].activityCode) || null;
                    // iterate destinationQuantity array
                    if (za.destinationQuantity && Array.isArray(za.destinationQuantity)) {
                        za.destinationQuantity.forEach(function(dq) {
                            // dq may contain identificationCode / quantity OR multiple indexed fields
                            var stores = [];
                            for (var k in dq) {
                                if (!dq.hasOwnProperty(k)) continue;
                                if (k.indexOf('identificationCode') === 0) {
                                    var idx = k.replace('identificationCode','');
                                    var qtyKey = 'quantity' + (idx || '');
                                    var store = dq[k];
                                    var qty = parseInt(dq[qtyKey], 10);
                                    if (store && !isNaN(qty)) stores.push({ store: store, qty: qty });
                                }
                            }
                            // fallback: single fields
                            if (stores.length === 0) {
                                var store = dq.identificationCode || dq.store || dq.identification || null;
                                var qty = parseInt(dq.quantity || dq.qty || dq.amount || 0, 10);
                                if (store && !isNaN(qty)) stores.push({ store: store, qty: qty });
                            }

                            stores.forEach(function(s) {
                                var key = (s.store || '') + '::' + (itemIdUpc || '');
                                if (!grouped[key]) grouped[key] = { store: s.store, upc: itemIdUpc, onhand: 0, sold: 0, onorder: 0 };
                                if (activityCode === 'QA') grouped[key].onhand += s.qty;
                                if (activityCode === 'QS') grouped[key].sold += s.qty;
                                if (activityCode === 'QP') grouped[key].onorder += s.qty;
                            });
                        });
                    }
                });
            }

            // For each grouped entry, resolve item via Setup Items lookup and create custom record
            var createdKeys = [];
            Object.keys(grouped).forEach(function(k) {
                var g = grouped[k];
                // Lookup setup item by UPC using customrecord_setup_items
                var nsItemId = null;
                try {
                    var setupSearch = search.create({ type: 'customrecord_setup_items', filters: [ ['custrecord_upc','is', g.upc] ], columns: [ 'custrecord_item','custrecord_link_to_customer' ] });
                    var res = setupSearch.run().getRange({ start: 0, end: 1 });
                    if (res && res.length > 0) {
                        nsItemId = res[0].getValue({ name: 'custrecord_item' }) || null;
                    }
                } catch (e) { log.debug('setup:lookup:error', String(e)); }

                try {
                    var rec = record.create({ type: 'customrecord_pos_852_processing', isDynamic: true });
                    if (g.onhand) rec.setValue({ fieldId: 'custrecord_pos_qty_onhand', value: g.onhand });
                    if (g.sold) rec.setValue({ fieldId: 'custrecord_pos_qty_sold', value: g.sold });
                    if (g.onorder) rec.setValue({ fieldId: 'custrecord_pos_qty_onorder', value: g.onorder });
                    if (g.store) rec.setValue({ fieldId: 'custrecord_pos_customer_store', value: g.store });
                    if (nsItemId) rec.setValue({ fieldId: 'custrecord_pos_item', value: nsItemId });
                    // store UPC in BPN field
                    if (g.upc) rec.setValue({ fieldId: 'custrecord_bpn', value: g.upc });
                    var savedId = rec.save({ enableSourcing: false, ignoreMandatoryFields: true });
                    createdKeys.push(savedId);
                } catch (e) { log.error('create:rec:error', String(e)); }
            });

            // write out created ids for summarize
            context.write({ key: (new Date()).getTime().toString(), value: JSON.stringify({ created: createdKeys }) });
        } catch (err) {
            log.error('map:error', err.toString());
            // propagate an error marker
            context.write({ key: 'error_' + (new Date()).getTime().toString(), value: JSON.stringify({ processed: false, error: String(err), source: context.value }) });
        }
    };

    /**
     * summarize: on completion, notify Orderful to accept delivery and delete temp file
     */
    const summarize = (summary) => {
        try {
            const script = runtime.getCurrentScript();
            const fileId = script.getParameter({ name: 'custscript_processing_file_id' });
            const apiKey = script.getParameter({ name: 'custscript_orderful_api_key' }) || '';
            const notifyTo = script.getParameter({ name: 'custscript_orderful_notify_email' }) || 'todd.h@beachhousegrp.com';
            const pollerParam = script.getParameter({ name: 'custscript_orderful_poller_id' }) || '';
            const emailAuthorParam = script.getParameter({ name: 'custscript_orderful_email_author_id' }) || '';

            // Build a basic summary text
            let summaryMsg = 'Map/Reduce Summary:\n';
            try { summaryMsg += 'Total keys: ' + summary.inputSummary.totalKeys + '\n'; } catch (e) {}
            try { summaryMsg += 'Map errors: ' + (summary.mapSummary.errors ? Object.keys(summary.mapSummary.errors).length : 0) + '\n'; } catch (e) {}
            try { summaryMsg += 'Reduce errors: ' + (summary.reduceSummary && summary.reduceSummary.errors ? Object.keys(summary.reduceSummary.errors).length : 0) + '\n'; } catch (e) {}

            // Attempt to read file again to determine transaction id to accept
            let transId = null;
            if (fileId) {
                try {
                    const f = file.load({ id: parseInt(fileId, 10) });
                    const parsed = JSON.parse(f.getContents() || '{}');
                    transId = parsed.id || parsed.transactionId || (parsed.transactionSets && parsed.transactionSets[0] && parsed.transactionSets[0].id) || null;

                    if (transId) {
                        const acceptUrl = (script.getParameter({ name: 'custscript_orderful_transaction_accept_url' }) || 'https://api.orderful.com/mosaic/transactions/{id}/delivery/accept').replace('{id}', transId);
                        try {
                            const resp = https.post({ url: acceptUrl, body: JSON.stringify({ accepted: true }), headers: { 'orderful-api-key': apiKey, 'Content-Type': 'application/json' } });
                            log.audit('Orderful accept', 'HTTP ' + resp.code + ' - ' + resp.body);
                            summaryMsg += '\nOrderful accept response: HTTP ' + resp.code + '\n' + resp.body + '\n';
                        } catch (e) {
                            log.error('orderful:accept:error', String(e));
                            summaryMsg += '\nOrderful accept error: ' + String(e) + '\n';
                        }

                        // If there were map errors and a poller id is available, attempt to clear the poller for this resource
                        try {
                            var mapErrorsCount = 0;
                            try { mapErrorsCount = summary.mapSummary && summary.mapSummary.errors ? Object.keys(summary.mapSummary.errors).length : 0; } catch (e) {}
                            var pollerId = pollerParam || (typeof parsed !== 'undefined' && (parsed.pollerId || parsed.pollingBucketId || parsed.poller_id || parsed.poller)) || null;
                            if (mapErrorsCount > 0 && pollerId) {
                                var retrievalUrl = 'https://api.orderful.com/v3/polling-buckets/' + pollerId + '/confirm-retrieval';
                                try {
                                    var retrievalResp = https.post({ url: retrievalUrl, body: JSON.stringify({ resourceIds: [transId] }), headers: { 'orderful-api-key': apiKey, 'Content-Type': 'application/json' } });
                                    log.audit('Orderful retrieval clear', 'HTTP ' + retrievalResp.code + ' - ' + retrievalResp.body);
                                    summaryMsg += '\nPoller clear response: HTTP ' + retrievalResp.code + '\n' + retrievalResp.body + '\n';
                                } catch (er) {
                                    log.error('orderful:retrieval:error', String(er));
                                    summaryMsg += '\nPoller clear error: ' + String(er) + '\n';
                                }
                            }
                        } catch (er2) { log.error('retrieval:outer:error', String(er2)); }
                    } else {
                        log.audit('summarize', 'No transaction id found in payload; skipping accept call');
                        summaryMsg += '\nNo transaction id found in payload; skipping accept call\n';
                    }
                } catch (e) {
                    log.error('summarize:file:read', String(e));
                    summaryMsg += '\nError reading payload file: ' + String(e) + '\n';
                }

                // Delete the temporary file to clean up
                try {
                    file.delete({ id: parseInt(fileId, 10) });
                    log.audit('cleanup', 'Deleted temp file ' + fileId);
                    summaryMsg += '\nDeleted temp file ' + fileId + '\n';
                } catch (e) {
                    log.error('cleanup:file:delete', String(e));
                    summaryMsg += '\nError deleting temp file: ' + String(e) + '\n';
                }
            }

            // Send notification email if configured
            try {
                if (notifyTo) {
                    var authorId = -5;
                    try { authorId = emailAuthorParam ? parseInt(emailAuthorParam, 10) : (runtime.getCurrentUser && runtime.getCurrentUser().id ? runtime.getCurrentUser().id : -5); } catch (e) { authorId = -5; }
                    var emailBody = 'Orderful Map/Reduce processing completed.\n\n' + summaryMsg + '\n\nThanks,\nBHG-EDI';
                    email.send({ author: authorId, recipients: notifyTo, subject: 'Orderful Processing Complete' + (transId ? ' - ' + transId : ''), body: emailBody });
                    log.audit('notification', 'Sent email to ' + notifyTo + ' from author ' + authorId);
                }
            } catch (e) { log.error('notification:error', String(e)); }
        } catch (err) {
            log.error('summarize:error', String(err));
        }
    };

    return { getInputData, map, summarize };
});
