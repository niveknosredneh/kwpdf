// ========== OCR UTILS ==========

window.ocrCache = {};
window.fileOcrEnabled = {};
window.ocrAbortController = null;
window.ocrCurrentUrl = null;

window.isOcrEnabled = function(url) {
    return window.fileOcrEnabled[url] === true;
};

window.toggleOcr = function(url) {
    const wasEnabled = window.isOcrEnabled(url);
    
    if (window.ocrCurrentUrl === url && window.ocrAbortController) {
        window.ocrAbortController.abort();
    }
    
    window.fileOcrEnabled[url] = !wasEnabled;
    window.ocrCache[url] = null;
    
    return window.fileOcrEnabled[url] === true;
};

window.enableOcr = function(url) {
    window.fileOcrEnabled[url] = true;
};

window.disableOcr = function(url) {
    if (window.ocrCurrentUrl === url && window.ocrAbortController) {
        window.ocrAbortController.abort();
    }
    window.fileOcrEnabled[url] = false;
};

window.cancelOcr = function() {
    if (window.ocrAbortController) {
        window.ocrAbortController.abort();
    }
};

window.updateOcrStatus = function(message, progress = null) {
    if (window.loader && window.loader.style.display !== 'none') {
        window.loaderStatus.textContent = message;
        if (progress !== null && window.loaderProgressFill) {
            window.loaderProgressFill.style.width = progress + '%';
        }
    } else if (window.statusBar) {
        window.statusBar.textContent = message;
    }
};

window.performOcrOnCanvas = async function(canvas, pageNum, pageTotal, fileName) {
    try {
        if (window.ocrAbortController && window.ocrAbortController.signal.aborted) {
            return '';
        }
        
        const result = await Tesseract.recognize(canvas, 'eng', {
            logger: m => {
                if (m.status === 'recognizing text') {
                    window.updateOcrStatus(`OCR: ${fileName} - Page ${pageNum}/${pageTotal} (${Math.round(m.progress * 100)}%)`, null);
                }
            },
            abortSignal: window.ocrAbortController ? window.ocrAbortController.signal : null
        });
        
        const text = result.data.text;
        console.log('[OCR] Page', pageNum, '- extracted', text.length, 'chars');
        
        return text;
    } catch (err) {
        if (err.name === 'AbortError') {
            console.log('[OCR] Cancelled');
            return '';
        }
        console.error('[OCR] Error:', err);
        return '';
    }
};

window.performOcrOnPdf = async function(url, pdf) {
    if (!window.fileOcrEnabled[url]) return null;
    
    window.ocrAbortController = new AbortController();
    window.ocrCurrentUrl = url;
    
    const fileName = url.split('/').pop().split('?')[0];
    console.log('[OCR] Starting OCR on:', fileName);
    
    window.updateOcrStatus(`OCR: ${fileName} - Starting...`, '85%');
    
    const allText = [];
    const totalPages = pdf.numPages;
    
    for (let p = 1; p <= totalPages; p++) {
        if (window.ocrAbortController.signal.aborted) {
            console.log('[OCR] Cancelled, stopping at page', p);
            break;
        }
        
        window.updateOcrStatus(`OCR: ${fileName} - Rendering page ${p}/${totalPages}...`, null);
        
        const page = await pdf.getPage(p);
        const viewport = page.getViewport({ scale: 2.0 });
        
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        
        await page.render({ canvasContext: ctx, viewport: viewport }).promise;
        
        window.updateOcrStatus(`OCR: ${fileName} - Scanning page ${p}/${totalPages}...`, null);
        
        const text = await window.performOcrOnCanvas(canvas, p, totalPages, fileName);
        allText.push(text);
    }
    
    window.ocrCurrentUrl = null;
    window.ocrAbortController = null;
    
    return allText.join('\n');
};

window.getOcrTextForFile = function(url) {
    return window.ocrCache[url] || null;
};

window.setOcrTextForFile = function(url, text) {
    window.ocrCache[url] = text;
};

window.clearOcrCache = function(url) {
    if (url) {
        delete window.ocrCache[url];
        delete window.fileOcrEnabled[url];
    } else {
        window.ocrCache = {};
        window.fileOcrEnabled = {};
    }
};