// ========== OCR UTILS ==========

window.ocrCache = {};
window.fileOcrEnabled = {};
window.ocrAbortController = null;
window.ocrCurrentUrl = null;
window.ocrScheduler = null;
window.ocrWorkers = [];
window.ocrRunningPromise = null; // Track the current OCR promise
window._ocrScratchCanvas = null; // Reusable canvas to reduce memory churn
window._ocrSchedulerInitPromise = null; // Deduplicate concurrent init calls

window.isOcrEnabled = function(url) {
    return window.fileOcrEnabled[url] === true;
};

window.toggleOcr = function(url) {
    const wasEnabled = window.isOcrEnabled(url);
    
    console.log(`[OCR DEBUG] Toggling OCR for ${url}: ${wasEnabled} -> ${!wasEnabled}`);
    
    if (window.ocrCurrentUrl === url && window.ocrAbortController) {
        window.ocrAbortController.abort();
    }
    
    window.fileOcrEnabled[url] = !wasEnabled;
    window.ocrCache[url] = null;
    
    console.log(`[OCR DEBUG] OCR now enabled: ${window.fileOcrEnabled[url]}`);
    
    // Show status message
    if (window.fileOcrEnabled[url]) {
        window.updateOcrStatus('OCR enabled - click to start scan', null);
    } else {
        window.updateOcrStatus('OCR disabled', null);
    }
    
    // If this is the currently loaded PDF and OCR is enabled, reload to trigger OCR
    if (window.currentDocUrl === url && window.fileOcrEnabled[url]) {
        console.log('[OCR DEBUG] Currently viewing this PDF, reloading to run OCR...');
        window.updateOcrStatus('Reloading PDF to start OCR scan...', null);
        // Force reload the PDF (skip early return) to trigger OCR processing
        if (typeof loadPDF === 'function') {
            loadPDF(url, "", true);
        } else if (typeof window.loadPDF === 'function') {
            window.loadPDF(url, "", true);
        }
    }
    
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
    // Always update the status bar so user can see OCR progress
    if (window.statusBar) {
        window.statusBar.textContent = message;
    }
    // Also update loader if it's visible
    if (window.loader && window.loader.style.display !== 'none') {
        window.loaderStatus.textContent = message;
        if (progress !== null && window.loaderProgressFill) {
            window.loaderProgressFill.style.width = progress + '%';
        }
    }
};

// Ensure OCR scheduler exists (idempotent helper)
window.ensureScheduler = async function(workerCount = 4) {
    // If already initialized, return immediately
    if (window.ocrScheduler) return true;
    // Deduplicate: if init is already in progress, wait for it
    if (window._ocrSchedulerInitPromise) return window._ocrSchedulerInitPromise;
    
    window._ocrSchedulerInitPromise = (async () => {
        try {
            const result = await window.initOcrScheduler(workerCount);
            return result;
        } finally {
            window._ocrSchedulerInitPromise = null;
        }
    })();
    
    return window._ocrSchedulerInitPromise;
};

// Initialize OCR scheduler with multiple workers for parallel processing
window.initOcrScheduler = async function(workerCount = 4) {
    console.log('[OCR DEBUG] Initializing OCR scheduler with', workerCount, 'workers...');
    
    // Check if Tesseract is available
    if (typeof Tesseract === 'undefined') {
        console.error('[OCR DEBUG] Tesseract.js is not loaded! Check CDN link in index.html');
        window.updateOcrStatus('OCR error: Tesseract.js not loaded');
        return false;
    }
    
    // Terminate any existing scheduler
    if (window.ocrScheduler) {
        console.log('[OCR DEBUG] Terminating existing scheduler...');
        await window.ocrScheduler.terminate();
        window.ocrScheduler = null;
    }
    
    try {
        // Create new scheduler
        window.ocrScheduler = Tesseract.createScheduler();
        console.log('[OCR DEBUG] Scheduler created');
        
        // Create and add workers one by one, waiting for each to be ready
        window.ocrWorkers = [];
        
        for (let i = 0; i < workerCount; i++) {
            console.log(`[OCR DEBUG] Creating worker ${i + 1}/${workerCount}...`);
            const worker = await Tesseract.createWorker('eng', 1, {
                langPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/tessdata'
            });
            window.ocrScheduler.addWorker(worker);
            window.ocrWorkers.push(worker);
            console.log(`[OCR DEBUG] Worker ${i + 1} created and added to scheduler`);
        }
        
        console.log(`[OCR] Initialized scheduler with ${workerCount} workers successfully`);
        return true;
    } catch (err) {
        console.error('[OCR DEBUG] Failed to initialize OCR scheduler:', err);
        window.ocrScheduler = null;
        window.updateOcrStatus('OCR initialization failed');
        return false;
    }
};

window.performOcrOnCanvas = async function(canvas, pageNum, pageTotal, fileName) {
    try {
        if (window.ocrAbortController && window.ocrAbortController.signal.aborted) {
            return '';
        }

        console.log(`[OCR DEBUG] Starting OCR on page ${pageNum}/${pageTotal} of ${fileName}`);
        console.log(`[OCR DEBUG] Canvas dimensions: ${canvas.width}x${canvas.height}`);
        
        // Use ensureScheduler for idempotent initialization
        const schedulerReady = await window.ensureScheduler();
        if (!schedulerReady || !window.ocrScheduler) {
            console.error('[OCR DEBUG] Failed to initialize OCR scheduler');
            return '';
        }
        
        const result = await window.ocrScheduler.addJob('recognize', canvas, 'eng', {
            logger: m => {
                if (m.status === 'recognizing text') {
                    window.updateOcrStatus(`OCR: ${fileName} - Page ${pageNum}/${pageTotal} (${Math.round(m.progress * 100)}%)`, null);
                }
            }
            // Note: abortSignal omitted - Tesseract workers don't clone it properly
        });
        
        const text = result.data.text;
        console.log(`[OCR DEBUG] Page ${pageNum} - extracted ${text.length} chars`);
        console.log(`[OCR DEBUG] Page ${pageNum} - first 200 chars: "${text.substring(0, 200)}"`);
        console.log(`[OCR DEBUG] Page ${pageNum} - confidence: ${result.data.confidence}%`);
        
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
    if (!window.fileOcrEnabled[url]) {
        console.log('[OCR DEBUG] OCR not enabled for', url);
        return null;
    }

    console.log('[OCR DEBUG] Starting OCR for', url);
    console.log('[OCR DEBUG] PDF has', pdf.numPages, 'pages');

    window.ocrAbortController = new AbortController();
    window.ocrCurrentUrl = url; // Track which URL is being processed
    const { signal } = window.ocrAbortController;

    const totalPages = pdf.numPages;
    const allText = new Array(totalPages);
    const allWords = new Array(totalPages); // Store word bboxes per page
    const activeJobs = [];
    const MAX_CONCURRENT_JOBS = 4; // Match your worker count

    // Show initial status
    window.updateOcrStatus(`Initializing OCR for ${totalPages}-page document...`, 85);

    // Use ensureScheduler for idempotent initialization
    const schedulerReady = await window.ensureScheduler();
    if (!schedulerReady || !window.ocrScheduler) {
        console.error('[OCR DEBUG] Failed to initialize OCR scheduler. Is Tesseract.js loaded?');
        window.updateOcrStatus('OCR initialization failed - check console');
        return null;
    }
    window.updateOcrStatus('OCR engine ready. Starting page scan...', 88);

    // Handle abort - terminate scheduler immediately to prevent new jobs
    const onAbort = () => {
        console.log('[OCR DEBUG] Abort signal received, terminating scheduler...');
        const scheduler = window.ocrScheduler;
        window.ocrScheduler = null; // Prevent new jobs immediately
        if (scheduler) {
            scheduler.terminate().catch(err => {
                console.error('[OCR DEBUG] Error terminating scheduler:', err);
            });
        }
        window.updateOcrStatus('OCR cancelled');
    };
    signal.addEventListener('abort', onAbort);

    try {
        for (let p = 1; p <= totalPages; p++) {
            if (signal.aborted) {
                console.log('[OCR DEBUG] OCR aborted at page', p);
                break;
            }

            // Dynamic progress: 88% start, 95% when all pages sent for OCR
            const progressPercent = 88 + Math.round((p / totalPages) * 7);
            console.log(`[OCR DEBUG] Processing page ${p}/${totalPages}...`);
            window.updateOcrStatus(`Preparing page ${p} of ${totalPages} for OCR scan...`, progressPercent);
            
            // Proper concurrency limiting: wait for ALL completed jobs to be removed
            // and only proceed when we're under the limit
            while (activeJobs.length >= MAX_CONCURRENT_JOBS) {
                await Promise.race(activeJobs);
                // Remove completed jobs from activeJobs
                // (they remove themselves in the then/catch handlers)
            }

            // Check if PDF document is still valid before calling getPage
            let page;
            try {
                page = await pdf.getPage(p);
            } catch (err) {
                console.error(`[OCR DEBUG] Failed to get page ${p}:`, err.message);
                console.log('[OCR DEBUG] PDF document may have been destroyed, stopping OCR');
                window.updateOcrStatus('OCR stopped - document changed', null);
                break;
            }
            
            const viewport = page.getViewport({ scale: 2.0 });
            console.log(`[OCR DEBUG] Page ${p} viewport: ${viewport.width}x${viewport.height}, scale: 2.0`);
            
            // Create a dedicated canvas for this page (don't reuse - OCR may read asynchronously)
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            const ctx = canvas.getContext('2d');
            
            window.updateOcrStatus(`Rendering page ${p}/${totalPages} to image...`, progressPercent);
            console.log(`[OCR DEBUG] Rendering page ${p} to canvas...`);
            const renderTask = page.render({ canvasContext: ctx, viewport: viewport });
            await renderTask.promise;
            // CRITICAL: Free PDF.js internal resources for this page
            page.cleanup();
            console.log(`[OCR DEBUG] Page ${p} rendered and cleaned up`);

            // Check if scheduler is still valid before adding job
            if (!window.ocrScheduler) {
                console.log('[OCR DEBUG] Scheduler is null, stopping OCR');
                window.updateOcrStatus('OCR stopped - scheduler terminated', null);
                break;
            }

            // Start the OCR job (no abortSignal - it can't be cloned for workers)
            const pageNum = p; // Capture page number for closure
            const job = window.ocrScheduler.addJob('recognize', canvas, 'eng').then(result => {
                allText[pageNum-1] = result.data.text;
                // Store word bboxes along with viewport info for coordinate conversion
                allWords[pageNum-1] = {
                    words: result.data.words || [],
                    viewportWidth: viewport.width,
                    viewportHeight: viewport.height,
                    scale: 2.0
                };
                const donePercent = 88 + Math.round((pageNum / totalPages) * 7);
                window.updateOcrStatus(`OCR scan complete: page ${pageNum}/${totalPages}`, donePercent);
                console.log(`[OCR DEBUG] Page ${pageNum} OCR completed: ${result.data.text.length} chars, confidence: ${result.data.confidence}%, words: ${allWords[pageNum-1].words.length}`);
                // Remove from active jobs
                const jobIndex = activeJobs.indexOf(job);
                if (jobIndex > -1) activeJobs.splice(jobIndex, 1);
            }).catch(err => {
                console.error(`[OCR DEBUG] Page ${pageNum} OCR failed:`, err);
                allText[pageNum-1] = '';
                allWords[pageNum-1] = { words: [], viewportWidth: 0, viewportHeight: 0, scale: 2.0 };
                const jobIndex = activeJobs.indexOf(job);
                if (jobIndex > -1) activeJobs.splice(jobIndex, 1);
            });

            activeJobs.push(job);
        }

        // Wait for the final batch to finish
        console.log('[OCR DEBUG] Waiting for all OCR jobs to complete...');
        window.updateOcrStatus('Finalizing OCR results...', 95);
        await Promise.all(activeJobs);
        
    } finally {
        // Clean up abort listener
        signal.removeEventListener('abort', onAbort);
    }
    
    const totalText = allText.join('\n');
    const pagesWithText = allText.filter(t => t && t.trim().length > 0).length;
    console.log(`[OCR DEBUG] OCR complete for ${url}`);
    console.log(`[OCR DEBUG] Total pages processed: ${allText.length}`);
    console.log(`[OCR DEBUG] Total text length: ${totalText.length} chars`);
    console.log(`[OCR DEBUG] Pages with text: ${pagesWithText}`);
    console.log(`[OCR DEBUG] First 500 chars of combined text: "${totalText.substring(0, 500)}"`);
    
    window.updateOcrStatus(`OCR complete: ${pagesWithText}/${totalPages} pages scanned`, 95);
    
    return { texts: allText, words: allWords }; // Return both texts and word bboxes
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

// Cleanup function to terminate workers when needed
window.cleanupOcr = async function() {
    if (window.ocrScheduler) {
        await window.ocrScheduler.terminate();
        window.ocrScheduler = null;
        window.ocrWorkers = [];
    }
};
