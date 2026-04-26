// ========== KEYWORD REGEX ==========

window.cachedKeywordRegex = null;
window.cachedKeywordList = null;

window.getKeywordRegex = function(keywords) {
    if (!keywords) keywords = window.KEYWORDS || [];
    if (!Array.isArray(keywords)) keywords = [];
    
    const keywordsJson = JSON.stringify(keywords);
    
    if (window.cachedKeywordRegex && window.cachedKeywordList === keywordsJson) {
        return window.cachedKeywordRegex;
    }
    
    if (keywords.length === 0) {
        window.cachedKeywordRegex = null;
        window.cachedKeywordList = keywordsJson;
        return window.cachedKeywordRegex;
    }
    
    const pattern = keywords
        .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');
    
    window.cachedKeywordRegex = new RegExp(`\\b(${pattern})\\b`, 'gi');
    window.cachedKeywordList = keywordsJson;
    return window.cachedKeywordRegex;
};

window.clearKeywordRegexCache = function() {
    window.cachedKeywordRegex = null;
    window.cachedKeywordList = null;
};