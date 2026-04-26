// ========== STATE ==========

window.activeKeyword = "";
window.currentDocType = 'pdf';

window.pdfDoc = null;
window.currentDocUrl = "";
window.currentScale = 1.0;
window.currentPage = 1;
window.totalPages = 0;

window.isNavigating = false;

// ========== PDF STATE ==========

// ========== PDF LOADING ==========

function loadPDF(fileUrl, keyword = "") {
    if (window.currentDocUrl === fileUrl && window.pdfDoc) {
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

    (async () => {
        try {
            window.pdfDoc = await pdfjsLib.getDocument(fileUrl).promise;
            window.currentDocUrl = fileUrl;
            window.totalPages = window.pdfDoc.numPages;

            window.loaderStatus.textContent = `Setting up ${window.totalPages} pages...`;
            window.loaderProgressFill.style.width = '30%';
            await window.setupVirtualPages();

            // Force render first page immediately
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
            window.loaderFilename.textContent = 'Error loading PDF';
            window.loaderStatus.textContent = err.message;
            window.loaderProgressFill.style.width = '0%';
            console.error('PDF load error:', err);
        }
    })();
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

// ========== PAGE SETUP & RENDERING (delegated to pdf_renderer.js) ==========

// ========== ZOOM ==========

window.setZoom = function(newScale, force = false) {
    const clampedScale = Math.max(0.5, Math.min(4.0, newScale));
    if (clampedScale === window.currentScale && !force) return;

    const oldScrollTop = window.viewerScroll.scrollTop;
    const oldScrollHeight = window.viewerScroll.scrollHeight;

    window.currentScale = clampedScale;
    window.updateZoomDisplay();

    for (let i = 1; i <= window.totalPages; i++) {
        const el = document.getElementById('page-' + i);
        if (!el) continue;
        const baseH = window.pageHeights[i] || 800;
        const cached = window.textPageCache[i];
        const baseW = cached ? cached.viewport.width : 600;
        el.style.width = (baseW * window.currentScale) + 'px';
        el.style.height = (baseH * window.currentScale) + 'px';
        const canvas = el.querySelector('canvas');
        if (canvas) {
            canvas.style.width = (baseW * window.currentScale) + 'px';
            canvas.style.height = (baseH * window.currentScale) + 'px';
        }
        const textLayer = el.querySelector('.textLayer');
        if (textLayer) {
            textLayer.style.width = (baseW * window.currentScale) + 'px';
            textLayer.style.height = (baseH * window.currentScale) + 'px';
        }
    }

    window.renderedPages.clear();
    window.renderedScales = {};

    requestAnimationFrame(() => {
        const newScrollHeight = window.viewerScroll.scrollHeight;
        const anchorFraction = oldScrollHeight > 0 ? oldScrollTop / oldScrollHeight : 0;
        const newScrollTop = anchorFraction * newScrollHeight;
        window.viewerScroll.scrollTop = newScrollTop + 30;

        window.clearHighlights();
        if (window.pageObserver) {
            window.pageObserver.disconnect();
            window.setupPageObserver();
        }
        if (window.searchResults.length > 0) {
            window.renderAllHighlights();
        }
        window.updateHeatmap();
    });
};

// ========== KEYWORD SELECT ==========

window.populateKeywordSelect = function() {
    window.keywordSelect.innerHTML = '';
    window.KEYWORDS.forEach(k => {
        if (window.searchCache[k] && window.searchCache[k].length > 0) {
            const opt = document.createElement('option');
            opt.value = k;
            opt.textContent = `${k} (${window.searchCache[k].length})`;
            if (k === window.activeKeyword) opt.selected = true;
            window.keywordSelect.appendChild(opt);
        }
    });
};

// ========== CLEAR SEARCH ==========

window.clearSearch = function() {
    window.activeKeyword = '';
    window.searchResults = [];
    window.currentMatchIndex = -1;
    window.navGroup.classList.remove('active');
    window.navSep.style.display = 'none';
    window.clearHighlights();
    window.keywordSelect.value = '';
    window.matchInput.value = '';
    window.matchTotal.textContent = '0';
    window.updateSidebarBadge();
    window.updateHeatmap();
};

window.clearAllResults = function() {
    window.resultsArea.innerHTML = '<h1 class="status-msg">&#10548;</h1><h1 class="status-msg">Drop a folder to begin scanning</h1>';
    const viewerDropMsg = document.getElementById('viewerDropMsg');
    if (viewerDropMsg) viewerDropMsg.style.display = 'block';
    window.statusBar.textContent = '';
    window.objectUrls.forEach(url => URL.revokeObjectURL(url));
    window.objectUrls = [];
    window.totalMatchesFound = 0;
    window.totalDocsFound = 0;
    window.docDataCache = {};
    window.docContentCache = {};
    window.docTextCache = {};
    window.expandedTreeItems.clear();
    window.updateStats();

    window.pdfDoc = null;
    window.currentDocUrl = "";
    window.currentDocType = 'pdf';
    window.currentScale = 1.0;
    window.currentPage = 1;
    window.totalPages = 0;
    window.viewer.innerHTML = '';
    window.renderedPages.clear();
    window.renderedScales = {};
    window.pageHeights = {};
    window.searchCache = {};
    window.clearSearch();
    window.currentScale = 1.0;
    window.currentPage = 1;
    window.textPageCache = {};
    docSearchResults = [];
    docCurrentMatchIndex = -1;
};

// ========== PRERENDER ==========

window.startPrerender = async function() {
    if (window.searchResults.length === 0) return;

    const pagesWithMatches = [...new Set(window.searchResults.map(r => r.page))];

    for (const pageNum of pagesWithMatches) {
        if (!isPageRendered(pageNum)) {
            await window.renderPageNow(pageNum);
        }
    }
};

// ========== KEYWORDS INIT ==========

const keywordListSelect = document.getElementById('keywordListSelect');

keywordListSelect.addEventListener('change', () => {
    const listName = keywordListSelect.value;
    if (window.switchKeywordList && window.switchKeywordList(listName)) {
        window.searchCache = {};
        window.clearSearch();
        if (window.objectUrls.length > 0) {
            window.rescanAllDocuments();
        }
    }
});

function populateListSelector() {
    const keywordListSelect = document.getElementById('keywordListSelect');
    if (!keywordListSelect) return;
    
    keywordListSelect.innerHTML = '';
    for (const name of Object.keys(window.KEYWORD_LISTS || {})) {
        const opt = document.createElement('option');
        opt.value = name;
        const list = window.KEYWORD_LISTS[name] || [];
        opt.textContent = `${name} (${list.length})`;
        keywordListSelect.appendChild(opt);
    }
    
    const savedListName = localStorage.getItem('tender_keyword_list') || window.DEFAULT_LIST_NAME;
    if (window.KEYWORD_LISTS && window.KEYWORD_LISTS[savedListName]) {
        keywordListSelect.value = savedListName;
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    if (typeof window.loadKeywords === 'function') {
        await window.loadKeywords();
    }
    populateListSelector();
    window.setupEventListeners();
});

// ========== KEYWORD MANAGER ==========

window.toggleKeywordManager = function() {
    const modal = document.getElementById('keywordManager');
    if (!modal) {
        console.error("Could not find keywordManager element in DOM");
        return;
    }

    const isShowing = modal.classList.toggle('show');
    console.log('toggleKeywordManager opened', isShowing);

    if (isShowing) {
        // Direct population of modal dropdown
        const modalSelector = document.getElementById('listSelector');
        console.log('direct modalSelector', { modalSelector: !!modalSelector, KW: window.KEYWORD_LISTS });
        
        if (modalSelector && window.KEYWORD_LISTS) {
            modalSelector.innerHTML = '';
            for (const name of Object.keys(window.KEYWORD_LISTS)) {
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                modalSelector.appendChild(opt);
                console.log('added', name);
            }
        }
        
        // Load editor
        if (window.loadListIntoEditor) {
            window.loadListIntoEditor();
        }
    }
};
