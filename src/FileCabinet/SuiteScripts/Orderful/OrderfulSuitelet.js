/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(['N/ui/serverWidget', 'N/https', 'N/file', 'N/task', 'N/runtime'], function(serverWidget, https, file, task, runtime) {
    function onRequest(context) {
        var scriptObj = runtime.getCurrentScript();
        if (context.request.method === 'GET') {
            // Updated Page Title
            const form = serverWidget.createForm({
                title: 'Orderful Mosaic Inbox - Dispatcher'
            });

            // Attach client script (keep existing file id if present in the account)
            form.clientScriptFileId = 4614058;

            // CSS Injection for Redwood theme compatibility
            var styleField = form.addField({
                id: 'custpage_css_injection',
                type: serverWidget.FieldType.INLINEHTML,
                label: ' '
            });
            styleField.defaultValue = '<style>' +
                '.my-blue-button { background-color: #0070d2 !important; color: white !important; font-weight: bold !important; border: 1px solid #005fb2 !important; border-radius: 3px !important; }' +
                '.my-blue-button:hover { background-color: #005fb2 !important; cursor: pointer; }' +
                '.my-disabled-button { background-color: #ebebeb !important; color: #8d8d8d !important; border: 1px solid #cccccc !important; cursor: not-allowed !important; }' +
                '#custpage_left_col { display: inline-block; width: 58%; vertical-align: top; box-sizing: border-box; }' +
                '#custpage_right_col { display: inline-block; width: 38%; vertical-align: top; box-sizing: border-box; margin-left: 2%; }' +
                '#custpage_left_col .uir-field-table, #custpage_right_col .uir-field-table { width: 100%; }' +
                '#custpage_data_display { margin-top: 20px; }' +
                '</style>';

            // Layout groups for left and right columns
            form.addFieldGroup({ id: 'custpage_left_col', label: 'Selection & Results' });
            form.addFieldGroup({ id: 'custpage_right_col', label: 'Instructions' });

            // We'll render the inbox as a sublist. Keep a hidden poller id field for compatibility.
            var pollerField = form.addField({ id: 'custpage_poller_id', type: serverWidget.FieldType.TEXT, label: 'Poller ID', container: 'custpage_left_col' });
            pollerField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            var configuredPoller = scriptObj.getParameter({ name: 'custscript_orderful_poller_id' }) || '50099';
            pollerField.defaultValue = configuredPoller;

            // Container for status messages
            form.addField({ id: 'custpage_status', type: serverWidget.FieldType.INLINEHTML, label: ' ', container: 'custpage_left_col' }).defaultValue = '<div id="data-display" style="border: 1px solid #ccc; padding: 12px; background: #fff; min-height: 60px; font-family: sans-serif;">Fetching inbox...</div>';

            var instructions = form.addField({ id: 'custpage_instructions', type: serverWidget.FieldType.INLINEHTML, label: ' ', container: 'custpage_right_col' });
            instructions.defaultValue = '<div style="background-color: #f0f4f8; border-left: 5px solid #0070d2; padding: 15px; font-family: sans-serif;">' +
                '<p style="font-weight: bold; margin-top: 0;">This utility is for processing 852 data that is too large for Celigo to process. Full instructions are available from the IT department.</p>' +
                '<ol style="margin-bottom: 0; line-height: 1.5;">' +
                '<li><b>Step 1:</b> Download the transactions from Orderful to your desktop.</li>' +
                '<li><b>Step 2:</b> Extract the files titled <b>"transaction-9999999.json"</b> from the zip file. Note: These are the <u>only</u> files needed. Place them on your desktop.</li>' +
                '<li><b>Step 3:</b> Click "Choose File" and select a transaction file.</li>' +
                '<li><b>Step 4:</b> Click <b>Inspect File Data</b> to verify the content.</li>' +
                '<li><b>Step 5:</b> Click <b>Create CSV Files</b>. Large transactions will automatically split into multiple files.</li>' +
                '<li><b>Step 6:</b> Click <b>Deliver and Clear</b> to update Orderful.</li>' +
                '<li><b>Final Step:</b> Navigate to the <a href="https://4675206.app.netsuite.com/app/setup/assistants/nsimport/importassistant.nl?recid=752&new=T" target="_blank" style="color: #0070d2; font-weight: bold;">Orderful Manual 852 import</a> to complete the process.</li>' +
                '</ol></div>';


            // Hidden field to receive the selected transaction id from the client script
            form.addField({ id: 'custpage_selected_transid', type: serverWidget.FieldType.TEXT, label: 'Selected Transaction' }).updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });

            // Add the inbox sublist
            var sublist = form.addSublist({ id: 'custpage_inbox', label: 'Orderful Inbox', type: serverWidget.SublistType.LIST, container: 'custpage_left_col' });
            sublist.addField({ id: 'custpage_select', type: serverWidget.FieldType.CHECKBOX, label: 'Select' });
            sublist.addField({ id: 'custpage_transid', type: serverWidget.FieldType.TEXT, label: 'Transaction ID' });
            sublist.addField({ id: 'custpage_received_at', type: serverWidget.FieldType.TEXT, label: 'Received At' });
            sublist.addField({ id: 'custpage_summary', type: serverWidget.FieldType.TEXT, label: 'Summary' });

            // Action buttons
            form.addButton({ id: 'custpage_process_btn', label: 'Process Selected', functionName: 'processSelected' });
            form.addButton({ id: 'custpage_clear_btn', label: 'Clear from Poller', functionName: 'clearSelectedPoller' });
            form.addButton({ id: 'custpage_refresh_btn', label: 'Refresh Inbox', functionName: 'refreshInbox' });

            // Try to fetch inbox and populate the sublist. Use script parameter for api key if available.
            var apiKey = scriptObj.getParameter({ name: 'custscript_orderful_api_key' }) || '';
            var inboxUrl = scriptObj.getParameter({ name: 'custscript_orderful_inbox_url' }) || 'https://api.orderful.com/mosaic/inbox';

            try {
                var inboxResp = https.get({ url: inboxUrl, headers: { 'orderful-api-key': apiKey, 'Content-Type': 'application/json' } });
                if (inboxResp.code >= 200 && inboxResp.code < 300) {
                    var inboxJson = JSON.parse(inboxResp.body || inboxResp);
                    // Attempt to find an array of transactions on common properties
                    var items = inboxJson.transactions || inboxJson.items || inboxJson || [];
                    // If the root is an object with many properties, but not array, coerce
                    if (!Array.isArray(items)) {
                        if (Array.isArray(inboxJson)) items = inboxJson; else items = [];
                    }

                    for (var i = 0; i < items.length; i++) {
                        var it = items[i] || {};
                        sublist.setSublistValue({ id: 'custpage_transid', line: i, value: '' + (it.id || it.transactionId || it.resourceId || '') });
                        sublist.setSublistValue({ id: 'custpage_received_at', line: i, value: '' + (it.receivedAt || it.timestamp || '') });
                        sublist.setSublistValue({ id: 'custpage_summary', line: i, value: '' + (it.summary || it.type || '') });
                    }
                    // Update status
                    var statusMsg = '<div style="padding:8px; color:#155724; background:#d4edda; border:1px solid #c3e6cb;">Inbox loaded: ' + items.length + ' item(s).</div>';
                    // If redirected from a processing POST, show a clear message
                    var reqStatus = context.request.parameters.status || context.request.parameters.custpage_status;
                    var startedTrans = context.request.parameters.transId || context.request.parameters.custpage_selected_transid;
                    if (reqStatus === 'processing') {
                        statusMsg = '<div style="padding:10px; color:#0c5460; background:#d1ecf1; border:1px solid #bee5eb; font-weight:bold;">Processing started in the background.' + (startedTrans ? ' Transaction: ' + startedTrans : '') + '</div>';
                    }
                    form.getField({ id: 'custpage_status' }).defaultValue = statusMsg;
                } else {
                    var _errBody = '';
                    try { _errBody = typeof inboxResp.body === 'string' ? inboxResp.body : JSON.stringify(inboxResp.body || ''); } catch (ee) { _errBody = String(inboxResp.body || ''); }
                    form.getField({ id: 'custpage_status' }).defaultValue = '<div style="padding:8px; color:#856404; background:#fff3cd; border:1px solid #ffeeba;">Could not load inbox. HTTP ' + inboxResp.code + ( _errBody ? ' - ' + _errBody : '' ) + '</div>';
                }
            } catch (e) {
                form.getField({ id: 'custpage_status' }).defaultValue = '<div style="padding:8px; color:#721c24; background:#f8d7da; border:1px solid #f5c6cb;">Error loading inbox: ' + String(e.message || e) + '</div>';
            }

            context.response.writePage(form);

        } else if (context.request.method === 'POST') {
            var params = context.request.parameters;
            // Expecting params.action === 'process' and params.transId (or from custpage_selected_transid)
            var action = params.action || context.request.body && (context.request.body.indexOf('action=') !== -1 ? decodeURIComponent(context.request.body.split('action=')[1].split('&')[0]) : null);
            var transId = params.transId || params.custpage_selected_transid || context.request.parameters.custpage_selected_transid;

            if (action === 'process' && transId) {
                try {
                    var apiKeyPost = scriptObj.getParameter({ name: 'custscript_orderful_api_key' }) || '';
                    var transactionUrlTemplate = scriptObj.getParameter({ name: 'custscript_orderful_transaction_url' }) || 'https://api.orderful.com/mosaic/transactions/{id}';
                    var transactionUrl = transactionUrlTemplate.replace('{id}', transId);

                    var txResp = https.get({ url: transactionUrl, headers: { 'orderful-api-key': apiKeyPost, 'Content-Type': 'application/json' } });
                    if (txResp.code < 200 || txResp.code >= 300) throw new Error('Fetch transaction failed: ' + txResp.code + ' - ' + txResp.body);

                    var contents = txResp.body || txResp;
                    // Create temporary file in File Cabinet
                    var stagingFolder = scriptObj.getParameter({ name: 'custscript_orderful_staging_folder' });
                    var tmp = file.create({ name: 'orderful_transaction_' + transId + '.json', fileType: file.Type.JSON, contents: contents });
                    if (stagingFolder) tmp.folder = parseInt(stagingFolder, 10);
                    var savedId = tmp.save();

                    // Submit Map/Reduce task and pass file id
                    var mrTask = task.create({ taskType: task.TaskType.MAP_REDUCE, scriptId: 'customscript_orderfulmapreuce', params: { custscript_processing_file_id: savedId } });
                    var submittedId = mrTask.submit();

                    // Respond with a simple processing acknowledgement including MR id; client will render an in-page banner and poll status
                    context.response.write('PROCESSING:' + transId + ':' + submittedId);
                    return;
                } catch (err) {
                    context.response.write('<html><body><div style="color:#a94442; font-weight:bold;">Error starting processing: ' + String(err.message || err) + '</div></body></html>');
                    return;
                }
            } else if (action === 'clearOrderful' || action === 'clearPoller') {
                // Backwards-compatible clear action (kept minimal)
                var apiKey = scriptObj.getParameter({ name: 'custscript_orderful_api_key' }) || '';
                try {
                    var confirmationResponse = https.post({ url: 'https://api.orderful.com/v3/transactions/confirm-delivery', body: JSON.stringify([{ deliveryStatus: 'DELIVERED', note: 'Processed via Orderful Mosaic Dispatcher', transactionId: params.transId }]), headers: { 'orderful-api-key': apiKey, 'Content-Type': 'application/json' } });
                    if (confirmationResponse.code < 200 || confirmationResponse.code >= 300) throw new Error('Confirm delivery failed: ' + confirmationResponse.code + ' - ' + confirmationResponse.body);
                    var pollerIdValue = params.pollerId || params.custpage_poller_id || scriptObj.getParameter({ name: 'custscript_orderful_poller_id' }) || null;
                    if (!pollerIdValue) throw new Error('Missing poller id');
                    var retrievalResponse = https.post({ url: 'https://api.orderful.com/v3/polling-buckets/' + pollerIdValue + '/confirm-retrieval', body: JSON.stringify({ resourceIds: [params.transId] }), headers: { 'orderful-api-key': apiKey, 'Content-Type': 'application/json' } });
                    if (retrievalResponse.code < 200 || retrievalResponse.code >= 300) throw new Error('Confirm retrieval failed: ' + retrievalResponse.code + ' - ' + retrievalResponse.body);
                    context.response.write('✅ Success: ' + params.transId + ' delivered and cleared.');
                } catch (e) {
                    context.response.write('❌ API Error: ' + e.message);
                }
            } else if (action === 'taskStatus') {
                // Return MR task status for polling
                var mrId = params.mrId || context.request.parameters.mrId || null;
                if (!mrId) { context.response.write(JSON.stringify({ error: 'missing mrId' })); return; }
                try {
                    var statusObj = task.checkStatus({ taskId: mrId });
                    context.response.write(JSON.stringify({ status: statusObj.status }));
                } catch (e) {
                    context.response.write(JSON.stringify({ error: String(e) }));
                }
            } else {
                context.response.write('No action performed.');
            }
        }
    }
    return { onRequest: onRequest };
});