/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */
define(['N/record', 'N/search', 'N/ui/serverWidget', 'N/file', 'N/log'],
    (record, search, serverWidget, file, log) => {

        const CSV_FIELD_ID = 'custpage_csvfile';

        const parseCSV = (text) => {
            // Robust CSV parser supporting quoted fields and commas inside quotes
            const rows = [];
            if (!text) return rows;
            let i = 0;
            let cur = '';
            let row = [];
            let inQuotes = false;
            while (i < text.length) {
                const ch = text[i];
                if (ch === '"') {
                    if (inQuotes && text[i+1] === '"') { // escaped quote
                        cur += '"';
                        i += 2;
                        continue;
                    }
                    inQuotes = !inQuotes;
                    i++;
                    continue;
                }
                if (ch === ',' && !inQuotes) {
                    row.push(cur);
                    cur = '';
                    i++;
                    continue;
                }
                if ((ch === '\n' || ch === '\r') && !inQuotes) {
                    // handle CRLF or LF
                    if (ch === '\r' && text[i+1] === '\n') i++;
                    row.push(cur);
                    cur = '';
                    // skip empty trailing line if present
                    if (row.length === 1 && row[0] === '') {
                        row = [];
                    } else {
                        rows.push(row);
                    }
                    row = [];
                    i++;
                    continue;
                }
                cur += ch;
                i++;
            }
            // push last field/row
            if (cur !== '' || row.length > 0) {
                row.push(cur);
                rows.push(row);
            }
            return rows;
        };

        const buildLookupMap = (recordType, nameFieldId) => {
            const map = {};
            try {
                const paged = search.create({
                    type: recordType,
                    columns: ['internalid', nameFieldId]
                }).runPaged({pageSize: 1000});

                paged.pageRanges.forEach((pageRange) => {
                    const page = paged.fetch({index: pageRange.index});
                    page.data.forEach((r) => {
                        const id = r.getValue({name: 'internalid'});
                        const name = r.getValue({name: nameFieldId});
                        if (name) map[String(name).trim().toUpperCase()] = id;
                    });
                });
            } catch (e) {
                log.error('buildLookupMap error', `${recordType} - ${e.message}`);
            }
            return map;
        };

        const findItemInternalId = (sku, cache) => {
            if (!sku) return null;
            sku = String(sku).trim();
            if (cache[sku]) return cache[sku];
            try {
                const s = search.create({
                    type: 'item',
                    filters: [ ['itemid', 'is', sku] ],
                    columns: ['internalid']
                }).run().getRange({start:0, end:1});
                if (s && s.length) {
                    const id = s[0].getValue({name: 'internalid'});
                    cache[sku] = id;
                    return id;
                }
            } catch (e) {
                log.error('findItemInternalId error', `sku=${sku} ${e.message}`);
            }
            cache[sku] = null;
            return null;
        };

        const upsertCrossRef = (data) => {
            // data should contain itemId, customerId, bpn, upc, price, selectionCode, colorId, sizeId
            try {
                const filters = [
                    ['custrecord_item', 'is', data.itemId], 'and',
                    ['custrecord_link_to_customer', 'is', data.customerId]
                ];
                const sr = search.create({
                    type: 'customrecord_setup_items',
                    filters: filters,
                    columns: ['internalid']
                }).run().getRange({start:0, end:1});

                let rec;
                if (sr && sr.length) {
                    rec = record.load({type: 'customrecord_setup_items', id: sr[0].getValue({name: 'internalid'}), isDynamic: false});
                } else {
                    rec = record.create({type: 'customrecord_setup_items', isDynamic: false});
                }

                if (data.itemId) rec.setValue({fieldId: 'custrecord_item', value: data.itemId});
                if (data.customerId) rec.setValue({fieldId: 'custrecord_link_to_customer', value: data.customerId});
                if (data.bpn != null) rec.setValue({fieldId: 'custrecord_bpn', value: data.bpn});
                if (data.upc != null) rec.setValue({fieldId: 'custrecord_upc', value: data.upc});
                if (data.price != null) rec.setValue({fieldId: 'custrecord_price', value: data.price});
                if (data.selectionCode != null) rec.setValue({fieldId: 'custrecord_sps_assortment_code', value: data.selectionCode});
                if (data.colorId) rec.setValue({fieldId: 'custrecord_gs1_color_code', value: data.colorId});
                if (data.sizeId) rec.setValue({fieldId: 'custrecord_gs1_size_code', value: data.sizeId});

                return rec.save();
            } catch (e) {
                log.error('upsertCrossRef error', e.message);
                throw e;
            }
        };

        const onRequest = (context) => {
            try {
                if (context.request.method === 'GET') {
                    const form = serverWidget.createForm({title: 'New Item Update - Upload Consolidated CSV'});
                    form.addField({id: CSV_FIELD_ID, type: serverWidget.FieldType.FILE, label: 'Consolidated CSV File'}).isMandatory = true;
                    form.addSubmitButton({label: 'Process CSV'});
                    context.response.writePage(form);
                    return;
                }

                // POST processing
                const uploaded = context.request.files && context.request.files[CSV_FIELD_ID];
                if (!uploaded) {
                    const f = serverWidget.createForm({title: 'Error - No file uploaded'});
                    f.addField({id: 'custpage_err', type: serverWidget.FieldType.INLINEHTML, label: 'Error'}).defaultValue = '<div style="color:red">No file uploaded. Please go back and choose a file.</div>';
                    f.addButton({id: 'custpage_back', label: 'Back', functionName: 'history.back()'});
                    context.response.writePage(f);
                    return;
                }

                const contents = uploaded.getContents();
                const rows = parseCSV(contents);
                if (!rows || rows.length < 2) {
                    const f = serverWidget.createForm({title: 'Error - Empty or invalid CSV'});
                    f.addField({id: 'custpage_err2', type: serverWidget.FieldType.INLINEHTML, label: 'Error'}).defaultValue = '<div style="color:red">CSV contained no data.</div>';
                    context.response.writePage(f);
                    return;
                }

                // Header processing
                const header = rows[0].map(h => String(h||'').trim());
                const idx = {};
                header.forEach((h, i) => { idx[h.toUpperCase()] = i; });

                // required columns
                const required = ['ITEM', 'LINK TO CUSTOMER', 'BPN', 'UPC', 'UNIT PRICE', 'SELECTION CODE', 'GS1 COLOR CODE', 'GS1 SIZE CODE'];
                required.forEach((col) => { if (!(col in idx)) log.audit('CSV header missing', col); });

                // Pre-build color and size lookups
                const colorMap = buildLookupMap('customrecord_gs1_color_codes', 'name');
                const sizeMap = buildLookupMap('customrecord_gs1_size_codes', 'name');

                // We'll cache item lookups
                const itemCache = {};

                // Determine customer id from first data row Link To Customer column. Extract numeric id from "CU-12345"
                const firstDataRow = rows[1];
                const linkVal = firstDataRow[idx['LINK TO CUSTOMER']];
                let customerId = null;
                if (linkVal) {
                    const m = String(linkVal).match(/CU-(\d+)/i);
                    if (m && m[1]) customerId = m[1];
                }
                if (!customerId) {
                    // fallback: try to parse any digits
                    const m2 = String(linkVal).match(/(\d{3,})/);
                    if (m2 && m2[1]) customerId = m2[1];
                }
                if (!customerId) throw new Error('Unable to extract customer internal id from CSV Link To Customer column');

                // Load customer ONCE for governance optimization
                let customerRec;
                try {
                    customerRec = record.load({type: record.Type.CUSTOMER, id: customerId, isDynamic: true});
                } catch (e) {
                    throw new Error('Failed to load customer ' + customerId + ': ' + e.message);
                }

                // Go through each data row and process
                let processedCount = 0;
                for (let r = 1; r < rows.length; r++) {
                    const row = rows[r];
                    if (!row || row.length === 0) continue;
                    try {
                        const sku = row[idx['ITEM']] || '';
                        const bpn = row[idx['BPN']] || '';
                        const upc = row[idx['UPC']] || '';
                        const priceRaw = row[idx['UNIT PRICE']] || '';
                        const selectionCode = row[idx['SELECTION CODE']] || '';
                        const colorName = (row[idx['GS1 COLOR CODE']] || '').toUpperCase().trim();
                        const sizeName = (row[idx['GS1 SIZE CODE']] || '').toUpperCase().trim();

                        const price = priceRaw === '' ? null : parseFloat(String(priceRaw).replace(/[^0-9.\-]/g, ''));

                        const itemId = findItemInternalId(sku, itemCache);
                        if (!itemId) {
                            log.audit('Item not found', sku);
                            continue;
                        }

                        const colorId = colorMap[colorName] || null;
                        const sizeId = sizeMap[sizeName] || null;

                        // Upsert custom cross-reference record
                        upsertCrossRef({
                            itemId: itemId,
                            customerId: customerId,
                            bpn: bpn,
                            upc: upc,
                            price: price,
                            selectionCode: selectionCode || null,
                            colorId: colorId,
                            sizeId: sizeId
                        });

                        // Update customer itempricing sublist in-memory
                        const sublistId = 'itempricing';
                        const lineCount = customerRec.getLineCount({sublistId: sublistId});
                        let foundLine = -1;
                        for (let li = 0; li < lineCount; li++) {
                            const existingItem = customerRec.getSublistValue({sublistId: sublistId, fieldId: 'item', line: li});
                            if (String(existingItem) === String(itemId)) { foundLine = li; break; }
                        }

                        if (foundLine > -1) {
                            customerRec.setSublistValue({sublistId: sublistId, fieldId: 'price', line: foundLine, value: price});
                        } else {
                            // insert new line at end
                            customerRec.selectNewLine({sublistId: sublistId});
                            customerRec.setCurrentSublistValue({sublistId: sublistId, fieldId: 'item', value: itemId});
                            if (price != null) customerRec.setCurrentSublistValue({sublistId: sublistId, fieldId: 'price', value: price});
                            customerRec.commitLine({sublistId: sublistId});
                        }

                        processedCount++;
                    } catch (rowErr) {
                        log.error('Row processing error', `row ${r+1}: ${rowErr.message}`);
                        // continue processing remaining rows
                    }
                }

                // Save customer once
                try {
                    customerRec.save();
                } catch (e) {
                    throw new Error('Failed to save customer: ' + e.message);
                }

                // Build success page
                const outForm = serverWidget.createForm({title: 'CSV Processed'});
                outForm.addField({id: 'custpage_statusmsg', type: serverWidget.FieldType.INLINEHTML, label: 'Status'}).defaultValue = `<div style="color:green">Success: Processed ${processedCount} rows and saved Customer (${customerId}).</div>`;
                outForm.addButton({id: 'custpage_back', label: 'Back', functionName: 'history.back()'});
                context.response.writePage(outForm);

            } catch (e) {
                log.error('Suitelet error', e.toString());
                const errForm = serverWidget.createForm({title: 'Processing Error'});
                errForm.addField({id: 'custpage_err', type: serverWidget.FieldType.INLINEHTML, label: 'Error'}).defaultValue = `<div style="color:red">Error during processing: ${String(e.message || e)}</div>`;
                errForm.addButton({id: 'custpage_back', label: 'Back', functionName: 'history.back()'});
                context.response.writePage(errForm);
            }
        };

        return { onRequest };
    });
