/**
 * @NApiVersion 2.x
 * @NScriptType ClientScript
 */
define(['N/currentRecord'], function(currentRecord) {
    var currentFileData = null;
    var MAX_RECORDS_PER_FILE = 24999; // 25,000 lines including header

    function setButtonStyle(elementId, isActive, isBlue) {
        var btn = document.getElementById(elementId);
        if (!btn) return;
        if (isActive) {
            btn.disabled = false;
            btn.classList.remove('my-disabled-button');
            if (isBlue) btn.classList.add('my-blue-button');
        } else {
            btn.disabled = true;
            btn.classList.add('my-disabled-button');
            btn.classList.remove('my-blue-button');
        }
    }

    function pageInit(context) {
        setButtonStyle('custpage_inspect_btn', false, false);
        setButtonStyle('custpage_download_btn', false, false);
        setButtonStyle('custpage_process_btn', false, false);
        var fileField = document.querySelector('input[name="custpage_file_upload"]');
        if (fileField) {
            fileField.addEventListener('change', function() {
                setButtonStyle('custpage_inspect_btn', this.files.length > 0, true);
            });
        }
    }

    function formatDate(dateStr) {
        if (!dateStr || dateStr.length !== 8) return 'N/A';
        return dateStr.substring(4, 6) + '/' + dateStr.substring(6, 8) + '/' + dateStr.substring(0, 4);
    }

    function formatTime(timeStr) {
        if (!timeStr || timeStr.length < 4) return 'N/A';
        var hours = parseInt(timeStr.substring(0, 2), 10);
        var minutes = timeStr.substring(2, 4);
        var ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12;
        hours = hours ? hours : 12;
        return hours + ':' + minutes + ' ' + ampm;
    }

    function inspectData() {
        var record = currentRecord.get();
        var fileInput = document.querySelector('input[name="custpage_file_upload"]');
        if (!fileInput || !fileInput.files[0]) return;
        var file = fileInput.files[0];
        var reader = new FileReader();
        reader.onload = function(e) {
            try {
                currentFileData = JSON.parse(e.target.result);
                var data = currentFileData;
                var match = file.name.match(/transaction-(\d+)\.json$/i);
                var transactionId = (match && match[1]) ? match[1] : 'N/A';
                record.setValue({ fieldId: 'custpage_transaction_id', value: transactionId });

                var funcGroup = data.functionalGroupHeader ? data.functionalGroupHeader[0] : {};
                var intHeader = data.interchangeControlHeader ? data.interchangeControlHeader[0] : {};
                var ts = data.transactionSets ? data.transactionSets[0] : {};
                var refs = ts.extendedReferenceInformation || [];
                var vendorRef = refs.filter(function(r) { return r.referenceIdentificationQualifier === 'IA'; })[0];
                var buyerRef = refs.filter(function(r) { return r.referenceIdentificationQualifier === 'BT'; })[0];

                var html = '<div style="line-height: 1.6; font-size: 13px;">';
                html += '<h3 style="color:#0070d2; margin-bottom:5px;">Transaction Data</h3>';
                html += '<b>ID:</b> ' + transactionId + '<br>';
                html += '<b>Sender ISA:</b> ' + (intHeader.interchangeSenderID || 'N/A').trim() + '<br>';
                html += '<b>Receiver ISA:</b> ' + (intHeader.interchangeReceiverID || 'N/A').trim() + '<br>';
                html += '<b>Date/Time:</b> ' + formatDate(funcGroup.date) + ' ' + formatTime(funcGroup.time) + '<br>';
                html += '<h3 style="color:#0070d2; margin-top:15px; margin-bottom:5px;">Vendor Data</h3>';
                if (ts.reportingDateAction) {
                    html += '<b>Start Date:</b> ' + formatDate(ts.reportingDateAction[0].date) + '<br>';
                    html += '<b>End Date:</b> ' + formatDate(ts.reportingDateAction[0].date1) + '<br>';
                }
                html += '<b>Vendor Number (IA):</b> ' + (vendorRef ? vendorRef.referenceIdentification : 'N/A') + '<br>';
                html += '<b>Buyer ID (BT):</b> ' + (buyerRef ? buyerRef.referenceIdentification : 'N/A') + '<br>';
                html += '</div>';
                document.getElementById('data-display').innerHTML = html;
                setButtonStyle('custpage_download_btn', true, true);
                setButtonStyle('custpage_process_btn', false, false);
            } catch (err) { alert('Error: ' + err.message); }
        };
        reader.readAsText(file);
    }

    function processDataAndDownload() {
        if (!currentFileData) return;
        var data = currentFileData;
        var groupedData = {};
        var funcGroup = data.functionalGroupHeader[0];
        var receiverCode = funcGroup.applicationReceiversCode;
        var senderCode = funcGroup.applicationSendersCode;
        var headerDate = funcGroup.date || '00000000';
        var transactionId = currentRecord.get().getValue('custpage_transaction_id');

        var retailerIDs = { "BEACHHOUSEPTTN": "849509", "BEACHHOUSEMOON": "339086", "BHGNOYZ": "2319103" };
        var retailerID = retailerIDs[receiverCode] || "TEST";

        data.transactionSets.forEach(function(ts) {
            var start = formatDate(ts.reportingDateAction[0].date);
            var end = formatDate(ts.reportingDateAction[0].date1);
            ts.LIN_loop.forEach(function(lin) {
                var item = lin.itemIdentification[0].productServiceID1.replace(/\u00A0/g, '').trim();
                lin.ZA_loop.forEach(function(za) {
                    var activityCode = za.productActivityReporting[0].activityCode;
                    za.destinationQuantity.forEach(function(dq) {
                        for (var i = 0; i <= 9; i++) {
                            var store = dq[i === 0 ? 'identificationCode' : 'identificationCode' + i];
                            var qty = parseInt(dq[i === 0 ? 'quantity' : 'quantity' + i]);
                            if (store && !isNaN(qty)) {
                                var key = start + '_' + item + '_' + store;
                                if (!groupedData[key]) {
                                    groupedData[key] = {
                                        ExternalID: retailerID + '_' + item + '_' + store + '_' + start.replace(/\//g, ''),
                                        RetailerId: retailerID, StartDate: start, EndDate: end, Item: item, Store: store,
                                        CurrentQty: 0, SoldQty: 0, OnOrderQty: 0
                                    };
                                }
                                if (activityCode === 'QA') groupedData[key].CurrentQty += qty;
                                if (activityCode === 'QS') groupedData[key].SoldQty += qty;
                                if (activityCode === 'QP') groupedData[key].OnOrderQty += qty;
                            }
                        }
                    });
                });
            });
        });

        var flattenedArray = Object.values(groupedData);
        var numChunks = Math.ceil(flattenedArray.length / MAX_RECORDS_PER_FILE); //

        // Clear display before starting downloads
        var display = document.getElementById('data-display');
        display.innerHTML += '<br><br><b style="color:#0070d2;">Starting Downloads...</b>';

        for (var p = 0; p < numChunks; p++) {
            var startIdx = p * MAX_RECORDS_PER_FILE;
            var endIdx = startIdx + MAX_RECORDS_PER_FILE;
            var chunk = flattenedArray.slice(startIdx, endIdx);
            
            var partNum = p + 1;
            var fileName = senderCode + '_' + receiverCode + '_' + headerDate + '_' + transactionId + '_Part' + partNum + '.csv'; //
            
            downloadCSV(chunk, fileName);
            display.innerHTML += '<br>✅ Part ' + partNum + ' created: ' + fileName;
        }

        setButtonStyle('custpage_process_btn', true, true);
    }

    function downloadCSV(rows, fileName) {
        var headers = "ExternalID,RetailerID,StartDate,EndDate,Item,Store,CurrentQty,SoldQty,OnOrderQty\n";
        var csvContent = headers + rows.map(function(r) {
            return [r.ExternalID, r.RetailerId, r.StartDate, r.EndDate, r.Item, r.Store, r.CurrentQty, r.SoldQty, r.OnOrderQty].join(',');
        }).join('\n');
        var blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        var link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.setAttribute("download", fileName);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    function processTransaction() {
        var record = currentRecord.get();
        var transId = record.getValue('custpage_transaction_id');
        var pollerId = record.getValue('custpage_poller_id');
        if (!transId || transId === 'N/A') {
            alert('Please inspect a file first so the transaction ID is populated.');
            return;
        }
        if (!pollerId) {
            alert('Poller ID is required to clear Orderful.');
            return;
        }

        if (confirm('Deliver and Clear Transaction ' + transId + '?')) {
            var params = new URLSearchParams();
            params.set('action', 'clearOrderful');
            params.set('transId', transId);
            params.set('pollerId', pollerId);

            fetch(window.location.href, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                body: params.toString()
            }).then(function(res) {
                return res.text().then(function(text) {
                    if (!res.ok) {
                        throw new Error('Status ' + res.status + ': ' + text);
                    }
                    return text;
                });
            }).then(function(msg) {
                document.getElementById('data-display').innerHTML += '<br><br><div style="padding:10px; border:1px solid #0070d2; background:#e0f0ff; font-weight:bold;">' + msg + '</div>';
                alert(msg);
            }).catch(function(err) {
                var errorHtml = '<br><br><div style="padding:10px; border:1px solid #d9534f; background:#fdecea; color:#a94442; font-weight:bold;">' +
                    'Error pushing transaction: ' + err.message + '</div>';
                document.getElementById('data-display').innerHTML += errorHtml;
                alert('Error pushing transaction: ' + err.message);
            });
        }
    }

    return { pageInit: pageInit, inspectData: inspectData, processTransaction: processTransaction, processDataAndDownload: processDataAndDownload };
});