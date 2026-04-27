// ========== PDF LOADER ==========

// Helper: Convert OCR words with bounding boxes to text items for search/highlight
function createItemsFromOcrWords(wordsData) {
    // wordsData: { words: [...], viewportWidth, viewportHeight, scale }
    const items = [];
    if (!wordsData || !wordsData.words || wordsData.words.length === 0) return items;
    
    const { words, viewportWidth, viewportHeight, scale } = wordsData;
    
    for (const word of words) {
        const { x0, y0, x1, y1 } = word.bbox;
        // Convert canvas pixels to PDF points (scale is 2.0)
        const pdfX = x0 / scale;
        // PDF y coordinate: canvas y increases downward from top, PDF y increases upward from bottom
        const pdfY = (viewportHeight - y1) / scale;
        const width = (x1 - x0) / scale;
        const height = (y1 - y0) / scale;
        
        items.push({
            text: word.text,
            transform: [height, 0, 0, height, pdfX, pdfY],
            width: width,
            height: height
        });
    }
    
    return items;
}

async function loadPDF(fileUrl, keyword = "", forceReload = false) {
    if (window.currentDocUrl === fileUrl && window.pdfDoc && !forceReload) {
        if (keyword) {
            window.performSearch(keyword);
        }
        return;
    }

    if (window.currentLayout === 'tree' && window.currentDocUrl && window.currentDocUrl !== fileUrl) {
        window.expandedTreeItems.delete(window.currentDocUrl);
    }
    if (window.currentLayout === 'tree' && fileUrl) {
        window.expandedTreeItems.add(fileUrl);
    }
    
    window.currentDocUrl = fileUrl;
    window.cancelBgRender();

    // Wait for any ongoing OCR to finish before destroying the PDF document
    if (window.ocrRunningPromise) {
        console.log('[OCR DEBUG] Waiting for OCR to finish before loading new PDF...');
        try {
            await window.ocrRunningPromise;
        } catch (e) {
            // OCR was aborted or failed, that's fine
        }
        window.ocrRunningPromise = null;
    }

    if (window.pdfDoc) {
        try {
            window.pdfDoc.destroy();
        } catch (e) {
            console.warn("Error destroying previous PDF:", e);
        }
        window.pdfDoc = null;
    }

    window.viewer.style.display = '';
    window.loader.style.display = 'flex';
    window.loaderFilename.textContent = 'Loading PDF...';
    window.loaderStatus.textContent = 'Initializing...';
    window.loaderProgressFill.style.width = '10%';
    window.viewer.innerHTML = '';
    window.renderedPages.clear();
    window.renderedScales = {};
    window.pageHeights = {};
    window.searchCache = {};
    window.clearSearch();
    window.currentScale = 1.0;
    window.currentPage = 1;
    window.textPageCache = {};

    try {
        window.pdfDoc = await pdfjsLib.getDocument(fileUrl).promise;
        window.currentDocUrl = fileUrl;
        window.totalPages = window.pdfDoc.numPages;

        window.loaderStatus.textContent = `Setting up ${window.totalPages} pages...`;
        window.loaderProgressFill.style.width = '30%';
        await window.setupVirtualPages();

        if (!window.isPageRendered(1)) {
            window.renderPageNow(1);
        }

        window.loaderStatus.textContent = 'Extracting text content...';
        window.loaderProgressFill.style.width = '60%';

        const cached = window.docTextCache[fileUrl];
        if (cached) {
            for (let i = 0; i < cached.pages.length; i++) {
                window.textPageCache[i + 1] = cached.pages[i];
            }
            window.loaderProgressFill.style.width = '80%';
            
            if (window.isOcrEnabled(fileUrl)) {
                window.loaderStatus.textContent = 'Running OCR...';
                window.loaderProgressFill.style.width = '85%';
                
                try {
                    console.log('[OCR DEBUG] Starting OCR process for', fileUrl);
                    // Track the OCR promise so we can wait for it if needed
                    window.ocrRunningPromise = window.performOcrOnPdf(fileUrl, window.pdfDoc);
                    const ocrResult = await window.ocrRunningPromise;
                    window.ocrRunningPromise = null;
                    
                    if (ocrResult && !window.ocrAbortController?.signal?.aborted) {
                        const { texts: ocrTexts, words: ocrWordsArray } = ocrResult;
                        console.log('[OCR DEBUG] OCR pages returned:', ocrTexts.length);
                        
                        // Update textPageCache with OCR text and create synthetic items for highlighting
                        for (let idx = 0; idx < ocrTexts.length; idx++) {
                            const pageNum = idx + 1;
                            const pageText = ocrTexts[idx];
                            const wordsData = ocrWordsArray[idx];
                            
                            // Reconstruct text from words for consistency with items
                            let ocrText = pageText;
                            if (wordsData && wordsData.words && wordsData.words.length > 0) {
                                ocrText = wordsData.words.map(w => w.text).join(' ');
                            }
                            
                            // Merge OCR text into textPageCache
                            if (window.textPageCache[pageNum]) {
                                console.log(`[OCR DEBUG] Page ${pageNum}: merging OCR text (${ocrText.length} chars)`);
                                window.textPageCache[pageNum].text += '\n' + ocrText;
                                
                                // Append OCR items to existing items for highlighting
                                if (wordsData && wordsData.words && wordsData.words.length > 0) {
                                    const ocrItems = createItemsFromOcrWords(wordsData);
                                    if (window.textPageCache[pageNum].items) {
                                        window.textPageCache[pageNum].items = 
                                            window.textPageCache[pageNum].items.concat(ocrItems);
                                    } else {
                                        window.textPageCache[pageNum].items = ocrItems;
                                    }
                                }
                            } else {
                                console.log(`[OCR DEBUG] Page ${pageNum}: setting new OCR text (${ocrText.length} chars)`);
                                const viewportHeight = wordsData ? wordsData.viewportHeight / wordsData.scale : 792;
                                const items = (wordsData && wordsData.words) ? 
                                    createItemsFromOcrWords(wordsData) : [];
                                window.textPageCache[pageNum] = {
                                    text: ocrText,
                                    viewport: { height: viewportHeight },
                                    items: items
                                };
                            }
                            
                            // Persist OCR text to docTextCache
                            if (cached && cached.pages[idx]) {
                                cached.pages[idx].text += '\n' + ocrText;
                            }
                        }
                        
                        // Update keyword counts for sidebar
                        const keywords = window.KEYWORDS || [];
                        const combinedRegex = window.getKeywordRegex(keywords);
                        const counts = {};
                        let totalMatches = 0;
                        
                        for (let pageNum = 1; pageNum <= window.totalPages; pageNum++) {
                            const pageText = window.textPageCache[pageNum]?.text || '';
                            let match;
                            while ((match = combinedRegex.exec(pageText)) !== null) {
                                if (match[0].length < 3) continue;
                                if (!/[a-zA-Z]/.test(match[0])) continue;
                                const lower = match[0].toLowerCase();
                                const key = keywords.find(k => k.toLowerCase() === lower) || lower;
                                counts[key] = (counts[key] || 0) + 1;
                                totalMatches++;
                            }
                        }
                        
                        // Update caches
                        cached.counts = cached.counts || {};
                        for (const k in counts) {
                            cached.counts[k] = (counts[k] || 0) + (cached.counts[k] || 0);
                        }
                        
                        if (window.docDataCache[fileUrl]) {
                            window.docDataCache[fileUrl].counts = { ...window.docDataCache[fileUrl].counts, ...counts };
                        }
                        
                        window.renderResultsArea();
                        console.log('[OCR] Found', totalMatches, 'keyword matches in OCR text');
                        window.loaderProgressFill.style.width = '90%';
                    }
                } catch (ocrErr) {
                    window.ocrRunningPromise = null;
                    if (ocrErr.name === 'AbortError') {
                        window.loaderStatus.textContent = 'OCR cancelled';
                        console.log('[OCR] Cancelled by user');
                    } else {
                        console.error('[OCR] Error:', ocrErr);
                    }
                }
            }
            
            await precomputeAllSearches();
        }

        window.loaderProgressFill.style.width = '100%';
        window.loader.style.display = 'none';
        window.updatePageInfo();
        window.updateZoomDisplay();
        window.pageInput.max = window.totalPages;
        window.pageTotal.textContent = window.totalPages;

        window.updateHeatmap();
        window.startBgRender();

        if (window.currentLayout === 'tree') {
            window.renderResultsArea();
        }

        if (keyword) {
            window.performSearch(keyword);
        }
    } catch (err) {
        window.ocrRunningPromise = null;
        window.loaderFilename.textContent = 'Error loading PDF';
        window.loaderStatus.textContent = err.message;
        window.loaderProgressFill.style.width = '0%';
        console.error('PDF load error:', err);
    }
}

function getDocTypeFromUrl(url) {
    const dataCached = window.docDataCache[url];
    if (dataCached?.type) {
        return dataCached.type;
    }
    if (dataCached?.name) {
        return window.getFileType(dataCached.name);
    }
    if (window.docContentCache[url]?.type) {
        return window.docContentCache[url].type;
    }
    if (url.includes('.pdf')) return 'pdf';
    if (url.includes('.docx')) return 'docx';
    if (url.includes('.doc')) return 'doc';
    return null;
}

function loadDocument(fileUrl, keyword = "") {
    const type = getDocTypeFromUrl(fileUrl);
    if (type === 'pdf') {
        loadPDF(fileUrl, keyword);
    } else if (type === 'docx' || type === 'doc') {
        window.loadDocxDoc(fileUrl, keyword);
    } else {
        loadPDF(fileUrl, keyword);
    }
}