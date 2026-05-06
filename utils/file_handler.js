// ========== FILE TYPE HELPERS ==========

window.getFileType = function(filename) {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.pdf')) return 'pdf';
    if (lower.endsWith('.docx')) return 'docx';
    if (lower.endsWith('.doc')) return 'doc';
    return null;
};

window.getFileIcon = function(filename) {
    const type = window.getFileType(filename);
    if (type === 'pdf') {
        return '<img src="icons/pdf.svg" width="18" height="18" alt="pdf">';
    }
    if (type === 'docx' || type === 'doc') {
        return '<img src="icons/docx.svg" width="18" height="18" alt="docx">';
    }
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="#757575"><path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z"/></svg>';
};

// ========== STATE ==========

window.objectUrls = [];
window.docTextCache = {};
window.docContentCache = {};
window.docDataCache = {};
window.basePath = '';
window.totalMatchesFound = 0;
window.totalDocsFound = 0;
window.processed = 0;
window.totalFiles = 0;

// ========== CACHE LIMITS ==========

window.MAX_CACHE_SIZE_TOTAL = 500 * 1024 * 1024; // 500MB total
window.MAX_CACHE_COUNT_PER_TYPE = 30; // 30 docs per PDF/DOCX cache
window.totalCacheSize = 0; // Tracks combined size of docTextCache + docContentCache

// ========== CACHE EVICTION ==========

window.evictCaches = function() {
  // Collect all non-current cache entries
  const allEntries = [];

  // Add PDF cache entries (skip current doc)
  Object.entries(window.docTextCache).forEach(([key, entry]) => {
    if (key !== window.currentDocUrl) {
      allEntries.push({ key, entry, cacheType: 'pdf' });
    }
  });

  // Add DOCX cache entries (skip current doc)
  Object.entries(window.docContentCache).forEach(([key, entry]) => {
    if (key !== window.currentDocUrl) {
      allEntries.push({ key, entry, cacheType: 'docx' });
    }
  });

  // Sort by oldest _lastAccess first
  allEntries.sort((a, b) => a.entry._lastAccess - b.entry._lastAccess);

   // Evict until limits are met
  for (const { key, entry, cacheType } of allEntries) {
    const pdfCount = Object.keys(window.docTextCache).length;
    const docxCount = Object.keys(window.docContentCache).length;

    const countOk = pdfCount <= window.MAX_CACHE_COUNT_PER_TYPE &&
                    docxCount <= window.MAX_CACHE_COUNT_PER_TYPE;
    const sizeOk = window.totalCacheSize <= window.MAX_CACHE_SIZE_TOTAL;

    if (countOk && sizeOk) break;

    // Evict entry
    if (cacheType === 'pdf') {
      delete window.docTextCache[key];
    }
    if (cacheType === 'docx') {
      delete window.docContentCache[key];
    }
    window.totalCacheSize -= (entry._size || 0);
  }
};

// ========== VERBOSE STATUS ==========

window._verboseInterval = null;

window.startVerboseStatus = function(fileName) {
    const keywords = window.KEYWORDS || [];
    // Remove file extension for display
    const nameWithoutExt = fileName.replace(/\.(pdf|docx?)$/i, '');
    const shortName = window.truncateFileName(nameWithoutExt, 20);
    if (keywords.length === 0) {
        window.statusBar.textContent = `Scanning ${shortName}..`;
        return;
    }
    let idx = 0;

    function updateStatus() {
        window.statusBar.textContent = `Scanning ${shortName} for "${keywords[idx % keywords.length]}"`;
        idx++;
        window._verboseRAF = requestAnimationFrame(updateStatus);
    }

    window._verboseRAF = requestAnimationFrame(updateStatus);
};

window.truncateFileName = function(name, maxLen) {
    if (name.length <= maxLen) return name;
    return name.slice(0, maxLen - 2) + '..';
};

window.stopVerboseStatus = function() {
    if (window._verboseRAF) {
        cancelAnimationFrame(window._verboseRAF);
        window._verboseRAF = null;
    }
};

// ========== PROCESS FILES ==========

window.processFiles = async function(files) {
    if (files.length === 0) return;

    const viewerMsg = document.getElementById('viewerDropMsg');
    if (viewerMsg) viewerMsg.style.display = 'none';

    const statusMsgs = window.resultsArea.querySelectorAll('.status-msg');
    statusMsgs.forEach(el => el.remove());

    window.progressBar.style.width = '0%';

    window.processed = 0;
    window.totalFiles = files.length;

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const url = URL.createObjectURL(file);
        window.objectUrls.push(url);

        window.startVerboseStatus(file.name);

        // Render placeholder card immediately so user can click it
        window.renderPlaceholderCard(file.name, url, file);

        try {
            const arrayBuffer = await file.arrayBuffer();
            const type = window.getFileType(file.name);

            if (type === 'pdf') {
                await window.extractPdfText(arrayBuffer, file.name, url, file);
            } else if (type === 'docx' || type === 'doc') {
                await window.extractDocText(arrayBuffer, file.name, url, file);
            }
        } finally {
            window.stopVerboseStatus();
            window.updateProgressMainThread();
        }
    }
};

// ========== EXTRACT PDF TEXT ==========

window.extractPdfText = async function(arrayBuffer, fileName, id, file) {
    try {
        const fakeDoc = {
            createElement: name => name === 'canvas' ? new OffscreenCanvas(1, 1) : null,
            fonts: {}
        };
        
        const pdfData = new Uint8Array(arrayBuffer);
        
        console.log('[PDF] Using native text extraction for:', fileName);
        const pdf = await pdfjsLib.getDocument({ data: pdfData, ownerDocument: fakeDoc }).promise;
        const numPages = pdf.numPages;
        const pageTextData = [];
        
        for (let p = 1; p <= numPages; p++) {
            const page = await pdf.getPage(p);
            const content = await page.getTextContent();
            const vp = page.getViewport({ scale: 1.0 });
            
            let pageText = '';
            for (const item of content.items) {
                pageText += item.str;
            }
            const textItems = [];
            for (const item of content.items) {
                textItems.push({
                    text: item.str,
                    transform: item.transform,
                    width: item.width,
                    height: item.height
                });
            }
            pageTextData.push({ text: pageText, viewport: { width: vp.width, height: vp.height }, items: textItems });
        }
        
        const keywords = window.KEYWORDS || [];
        const combinedRegex = window.getKeywordRegex(keywords);
        const counts = {};
        let totalMatches = 0;

        if (combinedRegex) {
            for (const pageData of pageTextData) {
                const text = pageData.text || '';
                let match;
                const regex = new RegExp(combinedRegex.source, 'gi');
                while ((match = regex.exec(text)) !== null) {
                    if (match[0].length < 3) continue;
                    if (!/[a-zA-Z]/.test(match[0])) continue;
                    const lower = match[0].toLowerCase();
                    const key = keywords.find(k => k.toLowerCase() === lower) || lower;
                    counts[key] = (counts[key] || 0) + 1;
                    totalMatches++;
                }
            }
        }

        console.log('[PDF] Processed', fileName, '- Found', totalMatches, 'matches');

        const pdfCacheEntry = {
            totalPages: numPages,
            pages: pageTextData,
            fileName,
            _lastAccess: Date.now(),
            _size: JSON.stringify(pageTextData).length + fileName.length
        };
        window.docTextCache[id] = pdfCacheEntry;
        window.totalCacheSize += pdfCacheEntry._size;
        window.evictCaches();
        window.totalDocsFound++;

        window.renderCard(fileName, counts, id, file);
        window.totalMatchesFound += totalMatches;
        window.updateStats();
    } catch (err) {
        console.error('[PDF] Error processing PDF:', err);
        window.updateProgressMainThread();
    }
};

// ========== EXTRACT DOC TEXT ==========

window.extractDocText = async function(arrayBuffer, fileName, id, file) {
    try {
        const type = window.getFileType(fileName);
        let htmlContent = '';
        let plainText = '';

        if (type === 'docx' || type === 'doc') {
            const htmlResult = await mammoth.convertToHtml({ arrayBuffer: arrayBuffer });
            htmlContent = htmlResult.value;
            const textResult = await mammoth.extractRawText({ arrayBuffer: arrayBuffer });
            plainText = textResult.value.replace(/\s+/g, ' ').trim();
        }

        if (!plainText && !htmlContent) {
            console.warn('[DOC] No text extracted from:', fileName);
            window.updateProgressMainThread();
            return;
        }

        const keywords = window.KEYWORDS || [];
        const combinedRegex = window.getKeywordRegex(keywords);
        const counts = {};
        let totalMatches = 0;
        let match;

        if (combinedRegex) {
            const regex = new RegExp(combinedRegex.source, 'gi');
            while ((match = regex.exec(plainText)) !== null) {
                if (match[0].length < 3) continue;
                if (!/[a-zA-Z]/.test(match[0])) continue;
                const lower = match[0].toLowerCase();
                const key = keywords.find(k => k.toLowerCase() === lower) || lower;
                counts[key] = (counts[key] || 0) + 1;
                totalMatches++;
            }
        }

        console.log('[DOC] Processed', fileName, '- Found', totalMatches, 'matches');

        const docxCacheEntry = {
            html: htmlContent,
            text: plainText,
            fileName,
            type,
            _lastAccess: Date.now(),
            _size: JSON.stringify({ html: htmlContent, text: plainText }).length + fileName.length
        };
        window.docContentCache[id] = docxCacheEntry;
        window.totalCacheSize += docxCacheEntry._size;
        window.evictCaches();
        window.totalDocsFound++;

        window.renderCard(fileName, counts, id, file);
        window.totalMatchesFound += totalMatches;
        window.updateStats();
    } catch (err) {
        console.error('[DOC] Error processing document:', err);
        window.updateProgressMainThread();
    }
};

// ========== DROP HANDLING ==========

window.handleDrop = async function(e) {
    const entries = [];
    if (e.dataTransfer.items) {
        for (let i = 0; i < e.dataTransfer.items.length; i++) {
            const entry = e.dataTransfer.items[i].webkitGetAsEntry();
            if (entry) entries.push(entry);
        }
    }
    window.basePath = '';
    let filesToProcess = [];

    const viewerMsg = document.getElementById('viewerDropMsg');
    if (viewerMsg) viewerMsg.style.display = 'none';
    const statusMsgs = window.resultsArea.querySelectorAll('.status-msg');
    statusMsgs.forEach(el => el.remove());

    for (const entry of entries) {
        if (entry.isFile && entry.name.toLowerCase().endsWith('.zip')) {
            window.statusBar.textContent = `Unzipping ${entry.name}...`;
            window.progressBar.style.width = '0%';
            const zipFile = await new Promise((resolve) => entry.file(resolve));
            window.basePath = zipFile.name.replace(/\.zip$/i, '');
            filesToProcess = filesToProcess.concat(await window.extractAllFromZip(zipFile));
        } else {
            window.statusBar.textContent = `Reading folder "${entry.name}"...`;
            window.progressBar.style.width = '0%';
            await window.traverseFileTree(entry, filesToProcess, '');
            window.basePath = entry.name;
        }
    }

    if (filesToProcess.length === 0) {
        window.statusBar.textContent = 'No supported files found';
        window.progressBar.style.width = '0%';
    } else {
        window.processFiles(filesToProcess);
    }
};

window.sidebar.addEventListener('drop', window.handleDrop);

// ========== TRAVERSE FILE TREE ==========

window.traverseFileTree = async function(item, fileList, baseDir = '') {
    const currentPath = baseDir ? baseDir + '/' + item.name : item.name;
    const type = window.getFileType(item.name);
    if (item.isFile && type) {
        const file = await new Promise((resolve) => item.file(resolve));
        file.relativePath = currentPath;
        fileList.push(file);
        if (fileList.length % 10 === 0) {
            window.statusBar.textContent = `Reading folder: found ${fileList.length} files...`;
        }
    } else if (item.isDirectory) {
        const dirReader = item.createReader();
        let entries = [];
        // readEntries may return entries in batches; keep reading until empty
        while (true) {
            const batch = await new Promise((resolve) => dirReader.readEntries(resolve));
            if (batch.length === 0) break;
            entries.push(...batch);
        }
        for (const entry of entries) await window.traverseFileTree(entry, fileList, currentPath);
    }
};

// ========== FOLDER INPUT ==========

document.getElementById('folderInput').addEventListener('change', async (e) => {
    const viewerMsg = document.getElementById('viewerDropMsg');
    if (viewerMsg) viewerMsg.style.display = 'none';
    const statusMsgs = window.resultsArea.querySelectorAll('.status-msg');
    statusMsgs.forEach(el => el.remove());

    let filesToProcess = [];
    const items = Array.from(e.target.files);
    const hasZip = items.some(f => f.name.toLowerCase().endsWith('.zip'));
    const folderName = items.length > 0 ? (items[0].webkitRelativePath || '').split('/')[0] : '';

    if (hasZip) {
        window.statusBar.textContent = 'Processing ZIP file...';
        window.progressBar.style.width = '0%';
    } else if (folderName) {
        window.statusBar.textContent = `Reading folder "${folderName}"...`;
        window.progressBar.style.width = '0%';
    }

    for (const file of items) {
        const type = window.getFileType(file.name);
        if (file.name.toLowerCase().endsWith('.zip')) {
            filesToProcess = filesToProcess.concat(await window.extractAllFromZip(file));
        } else if (type) {
            file.relativePath = file.webkitRelativePath || file.name;
            filesToProcess.push(file);
        }
    }

    if (filesToProcess.length === 0) {
        window.statusBar.textContent = 'No supported files found';
        window.progressBar.style.width = '0%';
    } else {
        window.processFiles(filesToProcess);
    }
});

// ========== ZIP EXTRACTION ==========

window.extractAllFromZip = async function(zipFile) {
    const sizeMB = (zipFile.size / (1024 * 1024)).toFixed(1);
    window.statusBar.textContent = `Unzipping ${zipFile.name} (${sizeMB} MB)...`;
    const zip = await JSZip.loadAsync(zipFile);

    const entries = [];
    zip.forEach((path, entry) => {
        if (!entry.dir && window.getFileType(path)) {
            entries.push({ path, entry });
        }
    });

    const total = entries.length;
    const extracted = [];
    let done = 0;

    for (const { path, entry } of entries) {
        const blob = await entry.async("blob");
        let mimeType = 'application/pdf';
        const type = window.getFileType(path);
        if (type === 'docx') mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        else if (type === 'doc') mimeType = 'application/msword';
        const file = new File([blob], path, { type: mimeType });
        file.relativePath = path;
        extracted.push(file);
        done++;
        const pct = Math.round((done / total) * 100);
        window.statusBar.textContent = `Unzipping ${zipFile.name}: ${done}/${total} files (${pct}%)`;
        window.progressBar.style.width = pct + '%';
    }

    return extracted;
};

// ========== RESCAN ==========

window.rescanAllDocuments = async function() {
    console.log('[PDF] rescanAllDocuments called');
    
    const viewerMsg = document.getElementById('viewerDropMsg');
    if (viewerMsg) viewerMsg.style.display = 'none';
    
    window.statusBar.textContent = `Scanning ${window.objectUrls.length} documents...`;
    window.progressBar.style.width = '0%';
    
    window.resultsArea.innerHTML = '';
    
    window.totalMatchesFound = 0;
    window.totalDocsFound = 0;
    
    const combinedRegex = window.getKeywordRegex(window.KEYWORDS);
    
    for (let i = 0; i < window.objectUrls.length; i++) {
        const url = window.objectUrls[i];
        const fileName = url.split('/').pop() || `Document ${i + 1}`;
        
        // Check PDF cache
        const pdfCached = window.docTextCache[url];
        if (pdfCached) {
            const counts = {};
            let fileTotalMatches = 0;
            
            if (combinedRegex) {
                for (let p = 0; p < pdfCached.pages.length; p++) {
                    const text = pdfCached.pages[p].text;
                    let match;
                    const regex = new RegExp(combinedRegex.source, 'gi');
                    while ((match = regex.exec(text)) !== null) {
                        if (match[0].length < 3) continue;
                        if (!/[a-zA-Z]/.test(match[0])) continue;
                        const lowerMatch = match[0].toLowerCase();
                        const originalKey = window.KEYWORDS.find(k => k.toLowerCase() === lowerMatch) || lowerMatch;
                        counts[originalKey] = (counts[originalKey] || 0) + 1;
                        fileTotalMatches++;
                    }
                }
            }
            
            const displayName = pdfCached.fileName || fileName;
            window.totalDocsFound++;
            
            if (fileTotalMatches > 0) {
                window.renderCard(displayName, counts, url);
                window.totalMatchesFound += fileTotalMatches;
            } else {
                window.renderNoMatchCard(displayName, url);
            }
            
            const pct = Math.round(((i + 1) / window.objectUrls.length) * 100);
            window.progressBar.style.width = pct + '%';
            continue;
        }
        
        // Check DOCX cache
        const docCached = window.docContentCache[url];
        if (docCached) {
            const counts = {};
            let fileTotalMatches = 0;
            
            if (combinedRegex && docCached.text) {
                const regex = new RegExp(combinedRegex.source, 'gi');
                let match;
                while ((match = regex.exec(docCached.text)) !== null) {
                    if (match[0].length < 3) continue;
                    if (!/[a-zA-Z]/.test(match[0])) continue;
                    const lowerMatch = match[0].toLowerCase();
                    const originalKey = window.KEYWORDS.find(k => k.toLowerCase() === lowerMatch) || lowerMatch;
                    counts[originalKey] = (counts[originalKey] || 0) + 1;
                    fileTotalMatches++;
                }
            }
            
            const displayName = docCached.fileName || fileName;
            window.totalDocsFound++;
            
            if (fileTotalMatches > 0) {
                window.renderCard(displayName, counts, url);
                window.totalMatchesFound += fileTotalMatches;
            } else {
                window.renderNoMatchCard(displayName, url);
            }
        }
        
        const pct = Math.round(((i + 1) / window.objectUrls.length) * 100);
        window.progressBar.style.width = pct + '%';
    }
    
    window.updateStats();
    
    if (window.totalMatchesFound === 0) {
        window.statusBar.textContent = "No matches found";
    } else {
        window.statusBar.textContent = `${window.totalMatchesFound} matches across ${window.totalDocsFound} document${window.totalDocsFound !== 1 ? 's' : ''}`;
    }
};

window.rescanWithNewKeywords = async function() {
    if (!window.pdfDoc || !window.currentDocUrl) return;

    const combinedRegex = window.getKeywordRegex(window.KEYWORDS);
    let totalMatches = 0;
    const docCounts = {};

    for (let pageNum = 1; pageNum <= window.totalPages; pageNum++) {
        const cached = window.textPageCache[pageNum];
        if (!cached) continue;
        const text = cached.text;
        let match;
        const regex = new RegExp(combinedRegex.source, 'gi');
        while ((match = regex.exec(text)) !== null) {
            if (match[0].length < 3) continue;
            if (!/[a-zA-Z]/.test(match[0])) continue;
            totalMatches++;
            const key = window.KEYWORDS.find(k => k.toLowerCase() === match[0].toLowerCase()) || match[0].toLowerCase();
            docCounts[key] = (docCounts[key] || 0) + 1;
        }
    }

    const activeCard = window.viewer.querySelector('.doc-card.active, .tree-header.active')?.closest('.doc-card') || window.viewer.querySelector('.doc-card.active');
    if (activeCard) {
        const cardName = activeCard.querySelector('.doc-name').textContent;
        const badgeGrid = activeCard.querySelector('.badge-grid');
        if (badgeGrid) {
            badgeGrid.innerHTML = '';
            window.KEYWORDS.forEach(k => {
                const count = docCounts[k] || 0;
                if (count > 0) {
                    const b = document.createElement('div');
                    b.className = 'badge';
                    b.textContent = `${k}: ${count}`;
                    b.onclick = (e) => {
                        e.stopPropagation();
                        window.cycleSearch(k);
                    };
                    badgeGrid.appendChild(b);
                }
            });
        }
    }

    window.totalMatchesFound = totalMatches;
    window.updateStats();
    window.precomputeAllSearches();
};
