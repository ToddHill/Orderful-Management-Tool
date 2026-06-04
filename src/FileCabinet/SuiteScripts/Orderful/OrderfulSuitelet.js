/**
 * @NApiVersion 2.x
 * @NScriptType Suitelet
 */
define(['N/ui/serverWidget', 'N/https'], function(serverWidget, https) {
    function onRequest(context) {
        if (context.request.method === 'GET') {
            // Updated Page Title
            var form = serverWidget.createForm({
                title: 'Orderful 852 Processing'
            });

            form.clientScriptFileId = '4614058'; 

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
            form.addFieldGroup({
                id: 'custpage_left_col',
                label: 'Selection & Results'
            });
            form.addFieldGroup({
                id: 'custpage_right_col',
                label: 'Instructions'
            });

            var fileUploadWrapper = form.addField({
                id: 'custpage_file_upload_wrapper',
                type: serverWidget.FieldType.INLINEHTML,
                label: 'Upload Transaction File',
                container: 'custpage_left_col'
            });
            fileUploadWrapper.defaultValue = '<div id="custpage_file_upload_box" style="margin-bottom: 12px; font-family: sans-serif;">' +
                '<label style="font-weight: bold; display: block; margin-bottom: 6px;">Upload Transaction File</label>' +
                '<input type="file" name="custpage_file_upload" accept=".json" style="width: 100%; padding: 6px 8px; border: 1px solid #ccd0d4; border-radius: 3px;" />' +
                '</div>';

            form.addField({
                id: 'custpage_poller_id',
                type: serverWidget.FieldType.TEXT,
                label: 'Poller ID',
                container: 'custpage_left_col'
            }).defaultValue = '50099';

            var instructions = form.addField({
                id: 'custpage_instructions',
                type: serverWidget.FieldType.INLINEHTML,
                label: ' ',
                container: 'custpage_right_col'
            });
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

            var transId = form.addField({
                id: 'custpage_transaction_id',
                type: serverWidget.FieldType.TEXT,
                label: 'Transaction ID',
                container: 'custpage_left_col'
            });
            transId.updateDisplayType({ displayType: serverWidget.FieldDisplayType.READONLY });

            form.addButton({ id: 'custpage_inspect_btn', label: 'Inspect File Data', functionName: 'inspectData' });
            form.addButton({ id: 'custpage_download_btn', label: 'Create CSV Files', functionName: 'processDataAndDownload' });
            form.addButton({ id: 'custpage_process_btn', label: 'Deliver and Clear', functionName: 'processTransaction' });

            var resultsField = form.addField({ id: 'custpage_data_display', type: serverWidget.FieldType.INLINEHTML, label: ' ', container: 'custpage_left_col' });
            resultsField.defaultValue = '<div id="data-display" style="border: 1px solid #ccc; padding: 15px; background: #fff; min-height: 80px; font-family: sans-serif;">Waiting for file selection...</div>';

            context.response.writePage(form);

        } else if (context.request.method === 'POST') {
            var params = context.request.parameters;
            if (params.action === 'clearOrderful') {
                var apiKey = '582c6d4de4a3454c9a66458f4a2b49e4';
                try {
                    var confirmationResponse = https.post({
                        url: 'https://api.orderful.com/v3/transactions/confirm-delivery',
                        body: JSON.stringify([{ deliveryStatus: 'DELIVERED', note: 'Processed via Orderful 852 Processing Utility', transactionId: params.transId }]),
                        headers: { 'orderful-api-key': apiKey, 'Content-Type': 'application/json' }
                    });

                    if (confirmationResponse.code < 200 || confirmationResponse.code >= 300) {
                        throw new Error('Confirm delivery failed: ' + confirmationResponse.code + ' - ' + confirmationResponse.body);
                    }

                    var retrievalResponse = https.post({
                        url: 'https://api.orderful.com/v3/polling-buckets/' + params.pollerId + '/confirm-retrieval',
                        body: JSON.stringify({ resourceIds: [params.transId] }),
                        headers: { 'orderful-api-key': apiKey, 'Content-Type': 'application/json' }
                    });

                    if (retrievalResponse.code < 200 || retrievalResponse.code >= 300) {
                        throw new Error('Confirm retrieval failed: ' + retrievalResponse.code + ' - ' + retrievalResponse.body);
                    }

                    context.response.write('✅ Success: ' + params.transId + ' delivered and cleared.');
                } catch (e) {
                    context.response.write('❌ API Error: ' + e.message);
                }
            }
        }
    }
    return { onRequest: onRequest };
});