(function () {
    let subtitleWindow = null;
    let subtitleContent = null;
    let trackList = null;
    let currentTracks = [];
    let currentCues = [];
    let activeVideo = null;
    let floatingLineWindow = null;
    let floatingLineText = null;
    let floatingTrackSelect = null;
    let floatingTrackRow = null;
    let lastFloatingLine = '—';
    let hoverPausedVideo = null;
    let hoverWasPlayingBeforePause = false;
    let hoveredTokenEl = null;
    let selectedTokenEl = null;
    let selectedTokenEls = [];
    let keepSelectedTokenUntil = 0;
    let isNormalizingTokenSelection = false;
    let lastRenderedFloatingLine = '';

    function createUI() {
        if (subtitleWindow) return;

        subtitleWindow = document.createElement('div');
        subtitleWindow.id = 'yt-subtitle-extractor-window';
        subtitleWindow.className = 'yt-subtitle-glass';

        const header = document.createElement('div');
        header.className = 'yt-subtitle-header';

        const titleContainer = document.createElement('div');
        titleContainer.style.display = 'flex';
        titleContainer.style.flexDirection = 'column';

        const titleSpan = document.createElement('span');
        titleSpan.innerText = 'YouTube Subtitles';
        titleSpan.id = 'yt-subtitle-main-title';

        const videoTitleSpan = document.createElement('small');
        videoTitleSpan.id = 'yt-subtitle-video-name';
        videoTitleSpan.style.opacity = '0.7';
        videoTitleSpan.style.fontSize = '10px';
        videoTitleSpan.style.whiteSpace = 'nowrap';
        videoTitleSpan.style.overflow = 'hidden';
        videoTitleSpan.style.textOverflow = 'ellipsis';
        videoTitleSpan.style.maxWidth = '200px';

        titleContainer.appendChild(titleSpan);
        titleContainer.appendChild(videoTitleSpan);
        header.appendChild(titleContainer);

        const controls = document.createElement('div');
        controls.className = 'yt-subtitle-controls';

        const trackBtn = document.createElement('button');
        trackBtn.innerText = 'Tracks';
        trackBtn.onclick = () => {
            trackList.style.display = trackList.style.display === 'none' ? 'block' : 'none';
        };
        controls.appendChild(trackBtn);

        const closeBtn = document.createElement('button');
        closeBtn.innerHTML = '&times;';
        closeBtn.onclick = () => {
            subtitleWindow.style.display = 'none';
        };
        controls.appendChild(closeBtn);
        header.appendChild(controls);

        trackList = document.createElement('div');
        trackList.id = 'yt-subtitle-track-list';
        trackList.style.display = 'none';

        subtitleContent = document.createElement('div');
        subtitleContent.className = 'yt-subtitle-content';
        subtitleContent.innerText = 'Loading...';

        subtitleWindow.appendChild(header);
        subtitleWindow.appendChild(trackList);
        subtitleWindow.appendChild(subtitleContent);
        subtitleWindow.style.display = 'none'; // keep extension UI hidden (user prefers native right sidebar transcript)
        document.body.appendChild(subtitleWindow);
        ensureFloatingLineWindow();

        // Make it draggable
        let isDragging = false;
        let offsetX, offsetY;

        header.onmousedown = (e) => {
            isDragging = true;
            offsetX = e.clientX - subtitleWindow.offsetLeft;
            offsetY = e.clientY - subtitleWindow.offsetTop;
        };

        document.onmousemove = (e) => {
            if (isDragging) {
                subtitleWindow.style.left = (e.clientX - offsetX) + 'px';
                subtitleWindow.style.top = (e.clientY - offsetY) + 'px';
                subtitleWindow.style.bottom = 'auto';
                subtitleWindow.style.right = 'auto';
            }
        };

        document.onmouseup = () => {
            isDragging = false;
        };
    }

    function refreshFloatingTrackOptions(tracks) {
        if (!floatingTrackSelect) return;
        floatingTrackSelect.innerHTML = '';

        if (!Array.isArray(tracks) || !tracks.length) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'No subtitle tracks';
            floatingTrackSelect.appendChild(opt);
            floatingTrackSelect.disabled = true;
            return;
        }

        floatingTrackSelect.disabled = false;
        tracks.forEach(track => {
            const name = track.name?.simpleText || track.languageCode || 'Track';
            const label = `${name}${track.kind === 'asr' ? ' (auto)' : ''}`;

            const opt = document.createElement('option');
            opt.value = track.baseUrl;
            opt.textContent = label;
            floatingTrackSelect.appendChild(opt);

            if (track.languageCode !== 'en') {
                const tr = document.createElement('option');
                tr.value = track.baseUrl + '&tlang=en';
                tr.textContent = `${label} → English`;
                floatingTrackSelect.appendChild(tr);
            }
        });
    }

    function updateTrackList(tracks) {
        currentTracks = tracks;
        refreshFloatingTrackOptions(tracks);
        trackList.innerHTML = '';

        const label = document.createElement('div');
        label.innerText = 'Select Track:';
        label.style.padding = '8px 12px';
        label.style.fontSize = '12px';
        label.style.fontWeight = 'bold';
        trackList.appendChild(label);

        tracks.forEach(track => {
            const item = document.createElement('div');
            item.className = 'yt-subtitle-track-item';

            const name = track.name?.simpleText || track.languageCode;
            item.innerText = name + (track.kind === 'asr' ? ' (auto)' : '');

            item.onclick = () => {
                fetchSubtitles(track.baseUrl);
                trackList.style.display = 'none';
            };
            trackList.appendChild(item);

            // Add Translate to English option if not already English
            if (track.languageCode !== 'en') {
                const transItem = document.createElement('div');
                transItem.className = 'yt-subtitle-track-item translate';
                transItem.innerText = '↳ Translate to English';
                transItem.onclick = () => {
                    fetchSubtitles(track.baseUrl + '&tlang=en');
                    trackList.style.display = 'none';
                };
                trackList.appendChild(transItem);
            }
        });
    }

    function decodeEntities(content) {
        return content.replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(n));
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function ensureFloatingLineWindow() {
        if (!floatingLineWindow) {
            if (!document.getElementById('yt-current-line-selection-style')) {
                const style = document.createElement('style');
                style.id = 'yt-current-line-selection-style';
                style.textContent = `
                  #yt-current-line-window ::selection { background: transparent !important; color: inherit !important; }
                  #yt-current-line-window ::-moz-selection { background: transparent !important; color: inherit !important; }
                `;
                document.head.appendChild(style);
            }

            floatingLineWindow = document.createElement('div');
            floatingLineWindow.id = 'yt-current-line-window';
            floatingLineWindow.style.margin = '10px 0';
            floatingLineWindow.style.padding = '10px 12px';
            floatingLineWindow.style.borderRadius = '10px';
            floatingLineWindow.style.background = 'rgba(66, 133, 244, 0.20)';
            floatingLineWindow.style.border = '1px solid rgba(120, 180, 255, 0.55)';
            floatingLineWindow.style.color = 'var(--yt-spec-text-primary, #fff)';
            floatingLineWindow.style.fontSize = '38px';
            floatingLineWindow.style.lineHeight = '1.6';
            floatingLineWindow.style.userSelect = 'text';
            floatingLineWindow.style.whiteSpace = 'pre-wrap';
            floatingLineWindow.style.display = 'block';
            floatingLineWindow.style.textAlign = 'center';

            const trackRow = document.createElement('div');
            floatingTrackRow = trackRow;
            trackRow.id = 'yt-current-line-track-row';
            trackRow.style.marginBottom = '8px';
            trackRow.style.display = 'none';
            trackRow.style.justifyContent = 'center';

            floatingTrackSelect = document.createElement('select');
            floatingTrackSelect.id = 'yt-current-line-track-select';
            floatingTrackSelect.style.maxWidth = '420px';
            floatingTrackSelect.style.width = '100%';
            floatingTrackSelect.style.fontSize = '13px';
            floatingTrackSelect.style.padding = '6px 8px';
            floatingTrackSelect.style.borderRadius = '8px';
            floatingTrackSelect.style.border = '1px solid rgba(120,180,255,0.45)';
            floatingTrackSelect.style.background = 'rgba(20,30,60,0.55)';
            floatingTrackSelect.style.color = 'inherit';
            floatingTrackSelect.disabled = true;
            floatingTrackSelect.addEventListener('change', () => {
                const baseUrl = (floatingTrackSelect.value || '').trim();
                if (baseUrl) fetchSubtitles(baseUrl);
            });
            trackRow.appendChild(floatingTrackSelect);

            floatingLineText = document.createElement('div');
            floatingLineText.id = 'yt-current-line-text';
            floatingLineText.textContent = '—';
            floatingLineText.style.cursor = 'text';

            floatingLineText.addEventListener('mousemove', (e) => {
                const token = e.target?.closest?.('[data-token="1"]');
                if (!token || token === hoveredTokenEl) return;
                clearHoveredToken();
                hoveredTokenEl = token;
                if (!isTokenSelected(hoveredTokenEl)) paintToken(hoveredTokenEl, 'hover');
            });
            floatingLineText.addEventListener('mouseleave', () => {
                clearHoveredToken();
            });
            floatingLineText.addEventListener('mousedown', () => {
                // Start of drag-selection: clear old token selection immediately.
                clearSelectedTokens();
            });
            floatingLineText.addEventListener('pointermove', () => {
                // Update highlight while dragging.
                updateSelectedTokensFromCurrentSelection();
            });
            floatingLineText.addEventListener('click', async (e) => {
                const token = e.target?.closest?.('[data-token="1"]');
                if (!token) return;
                e.preventDefault();
                e.stopPropagation();
                setSelectedToken(token);
                keepSelectedTokenUntil = Date.now() + 3000;
                const word = (token.textContent || '').trim();
                if (!word) return;
                await showWordByWordExplanation(word, null, token);
            });

            floatingLineWindow.appendChild(trackRow);
            floatingLineWindow.appendChild(floatingLineText);

            floatingLineWindow.addEventListener('mouseenter', () => {
                const video = getActiveVideoElement();
                if (!video) return;
                hoverPausedVideo = video;
                hoverWasPlayingBeforePause = !video.paused && !video.ended;
                if (hoverWasPlayingBeforePause) {
                    try { video.pause(); } catch (_) {}
                }
            });

            floatingLineWindow.addEventListener('mouseleave', () => {
                if (!hoverPausedVideo) return;
                // If explain popup is open, keep paused until popup closes.
                if (explainDialog && explainDialog.style.display !== 'none') return;
                if (hoverWasPlayingBeforePause) {
                    try {
                        const p = hoverPausedVideo.play?.();
                        if (p && typeof p.catch === 'function') p.catch(() => {});
                    } catch (_) {}
                }
                hoverPausedVideo = null;
                hoverWasPlayingBeforePause = false;
            });
        }

        if (!floatingLineWindow.isConnected) {
            const mount = document.querySelector('#below') || document.querySelector('#meta') || document.querySelector('#primary-inner');
            if (mount) {
                mount.prepend(floatingLineWindow);
            }
        }

        // Keep exactly one track row instance and keep it in floating window only.
        const dupRows = [...document.querySelectorAll('#yt-current-line-track-row')];
        if (dupRows.length > 1 && floatingTrackRow) {
            dupRows.forEach((el) => { if (el !== floatingTrackRow) el.remove(); });
        }

        if (floatingTrackRow && floatingTrackRow.parentElement !== floatingLineWindow) {
            floatingTrackRow.style.position = '';
            floatingTrackRow.style.left = '';
            floatingTrackRow.style.top = '';
            floatingTrackRow.style.width = '';
            floatingTrackRow.style.margin = '0 0 8px 0';
            floatingTrackRow.style.zIndex = '';
            floatingLineWindow.prepend(floatingTrackRow);
        }

        return floatingLineWindow;
    }

    function tokenizeWords(text) {
        const t = String(text || '').trim();
        if (!t) return [];
        try {
            if (typeof Intl !== 'undefined' && Intl.Segmenter) {
                const seg = new Intl.Segmenter(undefined, { granularity: 'word' });
                const out = [];
                for (const s of seg.segment(t)) {
                    const token = String(s.segment || '');
                    if (!token.trim()) continue;
                    out.push(token);
                }
                if (out.length) return out;
            }
        } catch (_) {}
        return t.split(/\s+/).filter(Boolean);
    }

    function paintToken(el, mode) {
        if (!el) return;
        if (mode === 'selected') {
            el.style.outline = '2px solid rgba(255,170,60,1)';
            el.style.background = 'rgba(255,140,0,0.42)';
            return;
        }
        if (mode === 'hover') {
            el.style.outline = '1px solid rgba(120,180,255,0.95)';
            el.style.background = 'rgba(120,180,255,0.22)';
            return;
        }
        el.style.outline = 'none';
        el.style.background = 'transparent';
    }

    function isTokenSelected(el) {
        return !!el && Array.isArray(selectedTokenEls) && selectedTokenEls.includes(el);
    }

    function clearHoveredToken() {
        if (!hoveredTokenEl) return;
        if (!isTokenSelected(hoveredTokenEl)) paintToken(hoveredTokenEl, 'none');
        hoveredTokenEl = null;
    }

    function clearSelectedTokens() {
        if (selectedTokenEl) paintToken(selectedTokenEl, 'none');
        selectedTokenEl = null;
        if (Array.isArray(selectedTokenEls) && selectedTokenEls.length) {
            selectedTokenEls.forEach(el => {
                if (el && el !== hoveredTokenEl) paintToken(el, 'none');
            });
        }
        selectedTokenEls = [];
    }

    function setSelectedToken(el) {
        clearSelectedTokens();
        selectedTokenEl = el || null;
        if (selectedTokenEl) {
            selectedTokenEls = [selectedTokenEl];
            paintToken(selectedTokenEl, 'selected');
        }
    }

    function normalizeSelectionToPickedTokens(selection, picked) {
        if (!selection || !picked || !picked.length) return;
        const first = picked[0];
        const last = picked[picked.length - 1];
        if (!first || !last) return;

        try {
            isNormalizingTokenSelection = true;
            const r = document.createRange();
            // Use element boundaries so the whole token is always included.
            r.setStartBefore(first);
            r.setEndAfter(last);
            selection.removeAllRanges();
            selection.addRange(r);
        } catch (_) {
            // ignore
        } finally {
            setTimeout(() => { isNormalizingTokenSelection = false; }, 0);
        }
    }

    function getPickedTokensFromSelection(selection) {
        if (!selection || !selection.rangeCount || !floatingLineText) return [];
        const range = selection.getRangeAt(0);
        const tokens = [...floatingLineText.querySelectorAll('[data-token="1"]')];
        return tokens.filter(tok => {
            try { return range.intersectsNode(tok); } catch { return false; }
        });
    }

    function setSelectedTokensFromSelection(selection) {
        clearSelectedTokens();
        const picked = getPickedTokensFromSelection(selection);
        if (!picked.length) return;
        selectedTokenEls = picked;
        selectedTokenEl = picked[0];
        picked.forEach(tok => paintToken(tok, 'selected'));
        normalizeSelectionToPickedTokens(selection, picked);
    }

    function updateSelectedTokensFromCurrentSelection() {
        const sel = window.getSelection?.();
        const text = (sel?.toString() || '').trim();
        if (!text || !sel?.anchorNode) {
            if (selectedTokenEl && Date.now() < keepSelectedTokenUntil) return;
            clearSelectedTokens();
            return;
        }
        const anchorEl = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
        const focusEl = sel.focusNode?.nodeType === 1 ? sel.focusNode : sel.focusNode?.parentElement;
        const inFloating = !!anchorEl?.closest?.('#yt-current-line-text') || !!focusEl?.closest?.('#yt-current-line-text');
        if (!inFloating) {
            if (selectedTokenEl && Date.now() < keepSelectedTokenUntil) return;
            clearSelectedTokens();
            return;
        }
        setSelectedTokensFromSelection(sel);
    }

    function renderFloatingLineTokens(text) {
        ensureFloatingLineWindow();
        const source = (text || '').trim();
        const value = source || lastFloatingLine || '—';

        // Avoid rebuilding DOM for identical line; keeps selected-token frame stable.
        if (value === lastRenderedFloatingLine && floatingLineText.childNodes.length > 0) {
            return;
        }
        lastRenderedFloatingLine = value;

        clearHoveredToken();
        clearSelectedTokens();
        floatingLineText.innerHTML = '';

        const tokens = tokenizeWords(value);
        if (!tokens.length) {
            floatingLineText.textContent = value;
            return;
        }

        tokens.forEach((tok, idx) => {
            const span = document.createElement('span');
            span.textContent = tok;
            span.dataset.token = '1';
            span.style.padding = '0 2px';
            span.style.borderRadius = '4px';
            span.style.transition = 'outline-color .08s ease, background-color .08s ease';
            floatingLineText.appendChild(span);
            if (idx < tokens.length - 1) floatingLineText.appendChild(document.createTextNode(' '));
        });
    }

    function setFloatingLineText(text) {
        ensureFloatingLineWindow();
        const next = (text || '').trim();
        if (next) lastFloatingLine = next;
        renderFloatingLineTokens(next || lastFloatingLine || '—');
    }

    function findCueByMs(ms) {
        if (!Array.isArray(currentCues) || !currentCues.length) return null;
        const exact = currentCues.find(c => ms >= c.startMs && ms <= c.endMs);
        if (exact) return exact;
        // Fallback: nearest cue that already started (handles tiny timing gaps)
        let prev = null;
        for (const c of currentCues) {
            if (c.startMs <= ms) prev = c;
            else break;
        }
        return prev;
    }

    function getLiveCaptionText() {
        const segs = [...document.querySelectorAll('.ytp-caption-window-container .ytp-caption-segment')]
            .map(el => (el.textContent || '').trim())
            .filter(Boolean);
        if (!segs.length) return '';
        return segs.join(' ').replace(/\s+/g, ' ').trim();
    }

    function parseTranscriptTimeToMs(raw) {
        const t = String(raw || '').trim();
        if (!t) return NaN;
        const parts = t.split(':').map(x => Number(x));
        if (parts.some(n => !Number.isFinite(n))) return NaN;
        if (parts.length === 3) return ((parts[0] * 3600) + (parts[1] * 60) + parts[2]) * 1000;
        if (parts.length === 2) return ((parts[0] * 60) + parts[1]) * 1000;
        if (parts.length === 1) return parts[0] * 1000;
        return NaN;
    }

    function getActiveTranscriptPanelLineByTime(currentMs) {
        const rows = [...document.querySelectorAll('ytd-transcript-segment-renderer')];
        if (!rows.length) return '';

        let best = '';
        let bestMs = -1;
        for (const row of rows) {
            const tsEl = row.querySelector('.segment-timestamp') || row.querySelector('#start-time') || row.querySelector('yt-formatted-string.segment-timestamp');
            const txEl = row.querySelector('.segment-text') || row.querySelector('yt-formatted-string.segment-text');
            const text = (txEl?.textContent || '').trim();
            if (!text) continue;
            const tms = parseTranscriptTimeToMs(tsEl?.textContent || '');
            if (!Number.isFinite(tms)) continue;
            if (tms <= currentMs && tms >= bestMs) {
                bestMs = tms;
                best = text;
            }
        }
        return best;
    }

    function handleVideoTimeUpdate() {
        if (!activeVideo) return;
        const ms = Math.floor((activeVideo.currentTime || 0) * 1000);
        const panel = getActiveTranscriptPanelLineByTime(ms);
        const cue = findCueByMs(ms);
        const live = getLiveCaptionText();
        // Prefer right transcript line by time, then timed cue, and only then live CC text.
        setFloatingLineText(panel || cue?.text || live || '');
    }

    function bindVideoTimeSync() {
        const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
        if (!video) return;
        if (activeVideo === video) return;

        if (activeVideo) {
            activeVideo.removeEventListener('timeupdate', handleVideoTimeUpdate);
            activeVideo.removeEventListener('seeked', handleVideoTimeUpdate);
        }

        activeVideo = video;
        activeVideo.addEventListener('timeupdate', handleVideoTimeUpdate);
        activeVideo.addEventListener('seeked', handleVideoTimeUpdate);
        handleVideoTimeUpdate();
    }

    let explainDialog = null;
    const explainCache = new Map();
    let explainPausedVideo = null;
    let explainWasPlayingBeforeOpen = false;
    let activeAIRequestId = '';
    let activeAIRequestInFlight = false;

    async function getAIProviderName() {
        try {
            const r = await chrome.runtime.sendMessage({ type: 'bridge:status' });
            const provider = String(r?.config?.aiProvider || 'gemini').toLowerCase();
            if (provider === 'gemini') return 'Gemini';
            if (provider === 'openai') return 'OpenAI';
            return 'OpenClaw';
        } catch (_) {
            return 'AI';
        }
    }

    async function fetchAIWordByWordExplanation(text, requestId) {
        const cacheKey = `ai:${text.trim()}`;
        if (explainCache.has(cacheKey)) return explainCache.get(cacheKey);

        const res = await chrome.runtime.sendMessage({ type: 'ai:explain', text, requestId });
        if (!res?.ok) {
            throw new Error(res?.error || 'AI explanation failed. Please check helper settings.');
        }

        const items = Array.isArray(res.items) ? res.items : [];
        explainCache.set(cacheKey, items);
        return items;
    }

    function renderAIErrorMessage(msg) {
        const safe = String(msg || 'Failed').replace(/</g, '&lt;');
        if (/missing\s+.*api key.*settings/i.test(safe)) {
            return `AI error: ${safe.replace(/settings/gi, '<a href="#" id="yt-open-settings-link">settings</a>')}`;
        }
        return `AI error: ${safe}`;
    }

    async function fetchDictionaryFirst(text) {
        const cacheKey = `dict:${text.trim()}`;
        if (explainCache.has(cacheKey)) return explainCache.get(cacheKey);

        const res = await chrome.runtime.sendMessage({ type: 'dict:lookup', text });
        if (!res?.ok) {
            throw new Error(res?.error || 'Dictionary lookup failed.');
        }

        const data = {
            items: Array.isArray(res.items) ? res.items : [],
            groups: Array.isArray(res.groups) ? res.groups : []
        };
        explainCache.set(cacheKey, data);
        return data;
    }

    function ensureExplainDialog() {
        if (explainDialog) return explainDialog;

        explainDialog = document.createElement('div');
        explainDialog.id = 'yt-word-explain-dialog';
        explainDialog.style.position = 'fixed';
        explainDialog.style.zIndex = '10000';
        explainDialog.style.left = '20px';
        explainDialog.style.top = '20px';
        explainDialog.style.width = '360px';
        explainDialog.style.maxHeight = 'min(70vh, calc(100vh - 16px))';
        explainDialog.style.overflowY = 'auto';
        explainDialog.style.overflowX = 'hidden';
        explainDialog.style.overscrollBehavior = 'contain';
        explainDialog.style.background = 'linear-gradient(160deg, rgba(72,38,108,0.95), rgba(46,26,84,0.93))';
        explainDialog.style.color = '#fff';
        explainDialog.style.border = '1px solid rgba(196,140,255,0.45)';
        explainDialog.style.borderRadius = '12px';
        explainDialog.style.boxShadow = '0 10px 30px rgba(0,0,0,0.4)';
        explainDialog.style.padding = '12px';
        explainDialog.style.fontSize = '13px';
        explainDialog.style.lineHeight = '1.5';
        explainDialog.style.display = 'none';

        document.body.appendChild(explainDialog);
        return explainDialog;
    }

    function getActiveVideoElement() {
        return document.querySelector('video.html5-main-video') || document.querySelector('video');
    }

    function pauseVideoForExplain() {
        if (explainDialog && explainDialog.style.display !== 'none' && explainPausedVideo) return;

        const video = getActiveVideoElement();
        if (!video) return;

        explainPausedVideo = video;
        explainWasPlayingBeforeOpen = !video.paused && !video.ended;
        if (explainWasPlayingBeforeOpen) {
            try { video.pause(); } catch (_) {}
        }
    }

    function resumeVideoAfterExplain() {
        if (!explainPausedVideo) return;
        if (!explainWasPlayingBeforeOpen) {
            explainPausedVideo = null;
            explainWasPlayingBeforeOpen = false;
            return;
        }
        try {
            const playPromise = explainPausedVideo.play?.();
            if (playPromise && typeof playPromise.catch === 'function') playPromise.catch(() => {});
        } catch (_) {}
        explainPausedVideo = null;
        explainWasPlayingBeforeOpen = false;
    }

    function resumeVideoAfterHoverIfNeeded() {
        if (!hoverPausedVideo) return;
        if (hoverWasPlayingBeforePause) {
            try {
                const p = hoverPausedVideo.play?.();
                if (p && typeof p.catch === 'function') p.catch(() => {});
            } catch (_) {}
        }
        hoverPausedVideo = null;
        hoverWasPlayingBeforePause = false;
    }

    function closeExplainDialog() {
        if (activeAIRequestInFlight && activeAIRequestId) {
            chrome.runtime.sendMessage({ type: 'ai:cancel', requestId: activeAIRequestId }).catch?.(() => {});
        }
        activeAIRequestInFlight = false;
        activeAIRequestId = '';

        if (explainDialog) explainDialog.style.display = 'none';
        try {
            const sel = window.getSelection?.();
            if (sel && sel.removeAllRanges) sel.removeAllRanges();
        } catch (_) {}
        clearHoveredToken();
        clearSelectedTokens();
        resumeVideoAfterExplain();
        resumeVideoAfterHoverIfNeeded();
    }

    function positionExplainDialogNearSelection(dialog, selection, anchorEl) {
        const GAP = 10;
        const MARGIN = 8;

        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        let rect = range?.getBoundingClientRect?.();
        if ((!rect || (!rect.width && !rect.height)) && anchorEl?.getBoundingClientRect) {
            rect = anchorEl.getBoundingClientRect();
        }
        if (!rect || (!rect.width && !rect.height)) {
            // Fallback position
            dialog.style.left = '20px';
            dialog.style.top = '20px';
            return;
        }

        const dialogRect = dialog.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        // Prefer below selection; if no room, place above
        let top = rect.bottom + GAP;
        if (top + dialogRect.height > vh - MARGIN) {
            top = rect.top - dialogRect.height - GAP;
        }
        if (top < MARGIN) top = MARGIN;

        // Align left with selection and clamp to viewport
        let left = rect.left;
        if (left + dialogRect.width > vw - MARGIN) {
            left = vw - dialogRect.width - MARGIN;
        }
        if (left < MARGIN) left = MARGIN;

        dialog.style.left = `${Math.round(left)}px`;
        dialog.style.top = `${Math.round(top)}px`;
    }

    function renderExplainItems(items) {
        if (!Array.isArray(items) || !items.length) return 'No results.';
        return items.map((it) => {
            const word = String(it.word || '').replace(/</g, '&lt;');
            const reading = String(it.reading || '').replace(/</g, '&lt;');
            const pos = String(it.partOfSpeech || '').replace(/</g, '&lt;');
            const meaning = String(it.meaning || '').replace(/</g, '&lt;');
            return `<div style="margin-bottom:10px;">
                <div><b>${word}</b>${reading ? ` <span style="opacity:.8;">(${reading})</span>` : ''}${pos ? ` <span style="opacity:.7;">[${pos}]</span>` : ''}</div>
                <div style="opacity:.95;">${meaning}</div>
            </div>`;
        }).join('');
    }

    function renderDictionaryGroups(groups) {
        if (!Array.isArray(groups) || !groups.length) return 'No results.';

        const tabButtons = groups.map((g, idx) => {
            const token = String(g.token || '').replace(/</g, '&lt;');
            const active = idx === 0;
            return `<button data-dict-tab="${idx}" style="
                appearance:none;
                border:1px solid ${active ? 'rgba(196,140,255,0.75)' : 'rgba(196,140,255,0.35)'};
                border-bottom:${active ? '1px solid rgba(72,38,108,0.95)' : '1px solid rgba(196,140,255,0.35)'};
                background:${active ? 'rgba(96,56,140,0.92)' : 'rgba(255,255,255,0.04)'};
                color:#fff;
                padding:6px 10px;
                border-top-left-radius:8px;
                border-top-right-radius:8px;
                margin-right:4px;
                cursor:pointer;
                font-weight:${active ? '700' : '500'};
                white-space:nowrap;
                overflow:visible;
            ">${token}</button>`;
        }).join('');

        const tabPanels = groups.map((g, idx) => {
            const body = (Array.isArray(g.items) && g.items.length)
                ? renderExplainItems(g.items)
                : `<div style="opacity:.8;">${String(g.error || 'No result').replace(/</g, '&lt;')}</div>`;
            return `<div data-dict-panel="${idx}" style="display:${idx === 0 ? 'block' : 'none'};padding:10px;border:1px solid rgba(196,140,255,0.35);border-radius:0 8px 8px 8px;background:rgba(255,255,255,0.03);">${body}</div>`;
        }).join('');

        return `
            <div data-dict-tabs-wrap>
                <div style="display:flex;align-items:flex-end;overflow-x:auto;overflow-y:hidden;padding-bottom:0;">${tabButtons}</div>
                <div>${tabPanels}</div>
            </div>
        `;
    }

    function adjustExplainDialogWidthForTabs(root) {
        if (!explainDialog || !root) return;
        const wrap = root.querySelector('[data-dict-tabs-wrap]');
        if (!wrap) return;
        const tabs = [...wrap.querySelectorAll('[data-dict-tab]')];
        if (!tabs.length) return;

        const tabsWidth = tabs.reduce((sum, btn) => sum + btn.scrollWidth + 6, 0) + 24;
        const minWidth = 360;
        const maxWidth = Math.max(420, Math.floor(window.innerWidth * 0.9));
        const target = Math.min(maxWidth, Math.max(minWidth, tabsWidth));
        explainDialog.style.width = `${target}px`;
    }

    function initDictionaryTabs(root) {
        if (!root) return;
        const tabs = [...root.querySelectorAll('[data-dict-tab]')];
        const panels = [...root.querySelectorAll('[data-dict-panel]')];
        if (!tabs.length || !panels.length) return;

        const activate = (idx) => {
            tabs.forEach((btn, i) => {
                const active = i === idx;
                btn.style.border = `1px solid ${active ? 'rgba(196,140,255,0.75)' : 'rgba(196,140,255,0.35)'}`;
                btn.style.borderBottom = active ? '1px solid rgba(72,38,108,0.95)' : '1px solid rgba(196,140,255,0.35)';
                btn.style.background = active ? 'rgba(96,56,140,0.92)' : 'rgba(255,255,255,0.04)';
                btn.style.fontWeight = active ? '700' : '500';
            });
            panels.forEach((panel, i) => {
                panel.style.display = i === idx ? 'block' : 'none';
            });
            adjustExplainDialogWidthForTabs(root);
        };

        tabs.forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = Number(btn.getAttribute('data-dict-tab') || '0');
                activate(Number.isFinite(idx) ? idx : 0);
            });
        });

        activate(0);
    }

    async function showWordByWordExplanation(text, selection, anchorEl) {
        if (!text || !text.trim()) return;

        const dialog = ensureExplainDialog();
        pauseVideoForExplain();
        dialog.style.display = 'block';
        dialog.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <strong>Word-by-word explanation</strong>
                <button id="yt-explain-close" style="background:transparent;color:#fff;border:none;font-size:18px;cursor:pointer;">&times;</button>
            </div>
            <div style="opacity:.8;margin-bottom:8px;">Selected: ${text.replace(/</g, '&lt;')}</div>
            <div style="margin-bottom:8px;">
              <div style="font-weight:600;margin-bottom:4px;">Dictionary</div>
              <div id="yt-dict-list" style="opacity:.95;">Looking up...</div>
            </div>
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
              <button id="yt-ai-btn" style="background:#3ea6ff;color:#111;border:none;border-radius:8px;padding:6px 10px;cursor:pointer;font-weight:600;">Get explanation by AI</button>
              <span id="yt-ai-status" style="opacity:.75;font-size:12px;"></span>
            </div>
            <div id="yt-explain-list"></div>
        `;

        positionExplainDialogNearSelection(dialog, selection, anchorEl);

        const closeBtn = dialog.querySelector('#yt-explain-close');
        if (closeBtn) {
            closeBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                closeExplainDialog();
            };
        }

        const dictList = dialog.querySelector('#yt-dict-list');
        const aiBtn = dialog.querySelector('#yt-ai-btn');
        const aiStatus = dialog.querySelector('#yt-ai-status');
        const list = dialog.querySelector('#yt-explain-list');

        if (aiBtn) {
            const providerName = await getAIProviderName();
            aiBtn.textContent = `Get explanation by AI (${providerName})`;
        }

        try {
            const dictData = await fetchDictionaryFirst(text);
            if (Array.isArray(dictData.groups) && dictData.groups.length) {
                dictList.innerHTML = renderDictionaryGroups(dictData.groups);
                initDictionaryTabs(dictList);
            } else {
                dictList.innerHTML = renderExplainItems(dictData.items || []);
            }
        } catch (err) {
            dictList.innerHTML = `Dictionary error: ${(err?.message || 'Failed').replace(/</g, '&lt;')}`;
        }
        positionExplainDialogNearSelection(dialog, selection, anchorEl);

        if (aiBtn) {
            aiBtn.onclick = async () => {
                aiBtn.disabled = true;
                aiStatus.textContent = 'Thinking...';
                list.innerHTML = '';

                const rid = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                activeAIRequestId = rid;
                activeAIRequestInFlight = true;

                try {
                    const items = await fetchAIWordByWordExplanation(text, rid);
                    if (!activeAIRequestInFlight || activeAIRequestId !== rid || !explainDialog || explainDialog.style.display === 'none') {
                        return;
                    }
                    list.innerHTML = `<div style="font-weight:600;margin-bottom:4px;">AI Explanation</div>${renderExplainItems(items)}`;
                    aiStatus.textContent = '';
                    positionExplainDialogNearSelection(dialog, selection, anchorEl);
                } catch (err) {
                    if (!activeAIRequestInFlight || activeAIRequestId !== rid || !explainDialog || explainDialog.style.display === 'none') {
                        return;
                    }
                    const msg = (err?.message || 'Failed').replace(/</g, '&lt;');
                    if (!/abort/i.test(msg)) {
                        list.innerHTML = renderAIErrorMessage(msg);
                        const settingsLink = list.querySelector('#yt-open-settings-link');
                        if (settingsLink) {
                            settingsLink.addEventListener('click', async (ev) => {
                                ev.preventDefault();
                                await chrome.runtime.sendMessage({ type: 'bridge:openOptions' });
                            });
                        }
                    }
                    aiStatus.textContent = '';
                } finally {
                    if (activeAIRequestId === rid) {
                        activeAIRequestInFlight = false;
                        activeAIRequestId = '';
                    }
                    aiBtn.disabled = false;
                }
            };
        }
    }

    function initSelectionExplain() {
        document.addEventListener('mouseup', async (e) => {
            if (explainDialog && explainDialog.style.display !== 'none' && e?.target && explainDialog.contains(e.target)) {
                return;
            }

            const selection = window.getSelection();
            let text = (selection?.toString() || '').trim();
            if (!text) return;

            const anchorNode = selection.anchorNode;
            const anchorElement = anchorNode?.nodeType === 1 ? anchorNode : anchorNode?.parentElement;
            const inTranscript = !!anchorElement?.closest?.('#yt-current-line-window, ytd-transcript-renderer, ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"], ytd-transcript-segment-renderer');
            if (!inTranscript) return;

            const inFloating = !!anchorElement?.closest?.('#yt-current-line-text');
            let anchorForPopup = anchorElement;
            if (inFloating) {
                const picked = getPickedTokensFromSelection(selection);
                if (picked.length) {
                    // Force full-token selection and use full-token text for explain.
                    setSelectedTokensFromSelection(selection);
                    text = picked.map(t => (t.textContent || '').trim()).filter(Boolean).join(' ');
                    anchorForPopup = picked[picked.length - 1] || anchorElement;
                }
            }

            await showWordByWordExplanation(text, selection, anchorForPopup);
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeExplainDialog();
        });

        document.addEventListener('selectionchange', () => {
            if (isNormalizingTokenSelection) return;
            updateSelectedTokensFromCurrentSelection();
        });

        document.addEventListener('pointerdown', (e) => {
            if (!explainDialog || explainDialog.style.display === 'none') return;
            if (explainDialog.contains(e.target)) return;

            const underVideo = e.target?.closest?.('#below, #meta, #primary-inner, #yt-current-line-window');
            if (!underVideo) return;

            // Single-click close on under-video empty area.
            closeExplainDialog();
        });
    }

    async function extractFromTranscriptPanel() {
        // Already open?
        let segments = document.querySelectorAll('ytd-transcript-segment-renderer .segment-text, ytd-transcript-segment-renderer yt-formatted-string.segment-text');
        if (!segments.length) {
            // Try opening from description (...more / ...)
            const showMore = [...document.querySelectorAll('tp-yt-paper-button, button, yt-formatted-string')]
                .find(el => /show transcript/i.test((el.innerText || '').trim()));
            if (showMore) {
                showMore.click();
                await sleep(700);
            }
        }

        // Wait briefly for transcript to render
        for (let i = 0; i < 8; i++) {
            segments = document.querySelectorAll('ytd-transcript-segment-renderer .segment-text, ytd-transcript-segment-renderer yt-formatted-string.segment-text');
            if (segments.length) break;
            await sleep(400);
        }

        if (!segments.length) return [];
        return [...segments].map(s => (s.innerText || '').trim()).filter(Boolean);
    }

    async function fetchSubtitles(baseUrl) {
        subtitleContent.innerText = 'Fetching...';
        try {
            // The baseUrl is already signed by YouTube - just add fmt=json3
            const jsonUrl = baseUrl + '&fmt=json3';
            let response = await fetch(jsonUrl, { credentials: 'include' });
            let text = await response.text();

            // If empty response, try video.google.com fallback
            if (!text || text.trim().length === 0) {
                const fallbackUrl = jsonUrl.replace('www.youtube.com/api/timedtext', 'video.google.com/timedtext');
                response = await fetch(fallbackUrl, { credentials: 'include' });
                text = await response.text();
            }

            if (text && text.trim().length > 0) {
                try {
                    const data = JSON.parse(text);
                    if (data.events) {
                        const cues = data.events
                            .filter(event => event && Array.isArray(event.segs) && event.segs.length)
                            .map(event => {
                                const text = event.segs.map(s => s?.utf8 || '').join('').replace(/\n/g, ' ').trim();
                                const startMs = Number(event.tStartMs);
                                const durationMs = Number(event.dDurationMs);
                                const safeStart = Number.isFinite(startMs) ? startMs : 0;
                                const safeDur = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 2500;
                                const endMs = safeStart + safeDur;
                                return { text, startMs: safeStart, endMs };
                            })
                            .filter(c => c.text);

                        const lines = cues.map(c => c.text);
                        currentCues = cues;
                        bindVideoTimeSync();

                        if (lines.length > 0) {
                            displaySubtitles(lines);
                            if (currentCues.length > 0) {
                                handleVideoTimeUpdate();
                            } else {
                                setFloatingLineText(lines[0]);
                            }
                            return;
                        }
                    }
                } catch (e) {
                    console.warn('JSON parsing failed:', e);
                }
            }

            // Fallback to XML format
            const xmlUrl = baseUrl.replace('www.youtube.com/api/timedtext', 'video.google.com/timedtext');
            const xmlResponse = await fetch(xmlUrl, { credentials: 'include' });
            const xmlText = await xmlResponse.text();

            // Manual Regex parsing to avoid Trusted Types DOMParser issues
            const regex = /<text\s+([^>]*)>([\s\S]*?)<\/text>/g;
            const lines = [];
            const cues = [];
            let match;
            while ((match = regex.exec(xmlText)) !== null) {
                const attrs = match[1] || '';
                const raw = decodeEntities(match[2] || '').trim();
                if (!raw) continue;
                lines.push(raw);

                const s = attrs.match(/\sstart="([0-9.]+)"/);
                const d = attrs.match(/\sdur="([0-9.]+)"/);
                const startMs = s ? Math.floor(parseFloat(s[1]) * 1000) : 0;
                const endMs = startMs + (d ? Math.floor(parseFloat(d[1]) * 1000) : 2500);
                cues.push({ text: raw, startMs, endMs });
            }

            if (lines.length > 0) {
                currentCues = cues;
                bindVideoTimeSync();
                displaySubtitles(lines);
                handleVideoTimeUpdate();
                return;
            }

            // Final fallback: scrape transcript panel from DOM
            const domLines = await extractFromTranscriptPanel();
            if (domLines.length > 0) {
                currentCues = [];
                setFloatingLineText(domLines[0] || '');
                displaySubtitles(domLines);
            } else {
                subtitleContent.innerText = 'No subtitles available for this track.';
            }

        } catch (err) {
            subtitleContent.innerText = 'Error: ' + err.message;
        }
    }

    function displaySubtitles(lines) {
        subtitleContent.innerHTML = '';
        lines.forEach(line => {
            const p = document.createElement('p');
            p.innerText = line;
            subtitleContent.appendChild(p);
        });
        subtitleContent.scrollTop = 0;
    }

    window.addEventListener('message', (event) => {
        if (event.data.type === 'YOUTUBE_SUBTITLES_DATA') {
            createUI();
            subtitleWindow.style.display = 'none';
            document.getElementById('yt-subtitle-video-name').innerText = event.data.videoTitle;

            updateTrackList(event.data.captionTracks || []);

            // Default: fetch English or the first one
            const tracks = event.data.captionTracks || [];
            const defaultTrack = tracks.find(t => t.languageCode === 'en') || tracks[0];
            if (defaultTrack) {
                if (floatingTrackSelect) floatingTrackSelect.value = defaultTrack.baseUrl;
                fetchSubtitles(defaultTrack.baseUrl);
            } else {
                subtitleContent.innerText = 'No tracks found.';
            }
        } else if (event.data.type === 'YOUTUBE_SUBTITLES_NOT_FOUND') {
            createUI();
            subtitleWindow.style.display = 'none';
            subtitleContent.innerText = 'No subtitles found for this video.';
            if (trackList) trackList.innerHTML = '';
        }
    });

    function init() {
        ensureFloatingLineWindow();
        bindVideoTimeSync();

        // YouTube DOM can render late; retry mounting below video a few times.
        let mountRetries = 0;
        const mountTimer = setInterval(() => {
            ensureFloatingLineWindow();
            bindVideoTimeSync();
            handleVideoTimeUpdate();
            mountRetries += 1;
            if ((floatingLineWindow && floatingLineWindow.isConnected && floatingLineWindow.closest('#below, #meta, #primary-inner')) || mountRetries >= 20) {
                clearInterval(mountTimer);
            }
        }, 500);

        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('inject.js');
        (document.head || document.documentElement).appendChild(script);
        script.onload = () => script.remove();
    }

    init();
    initSelectionExplain();

    window.addEventListener('yt-navigate-finish', () => {
        currentCues = [];
        setFloatingLineText('');
        if (subtitleWindow) {
            subtitleContent.innerText = 'Loading...';
        }
        init();
    });
})();
