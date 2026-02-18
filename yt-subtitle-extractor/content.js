(function () {
    let subtitleWindow = null;
    let subtitleContent = null;
    let trackList = null;
    let currentTracks = [];
    let currentCues = [];
    let activeVideo = null;
    let floatingLineWindow = null;
    let floatingLineText = null;
    let lastFloatingLine = '—';
    let hoverPausedVideo = null;
    let hoverWasPlayingBeforePause = false;
    let hoveredTokenEl = null;
    let selectedTokenEl = null;
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

    function updateTrackList(tracks) {
        currentTracks = tracks;
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

            floatingLineText = document.createElement('div');
            floatingLineText.id = 'yt-current-line-text';
            floatingLineText.textContent = '—';
            floatingLineText.style.cursor = 'text';

            floatingLineText.addEventListener('mousemove', (e) => {
                const token = e.target?.closest?.('[data-token="1"]');
                if (!token || token === hoveredTokenEl) return;
                clearHoveredToken();
                hoveredTokenEl = token;
                if (hoveredTokenEl !== selectedTokenEl) paintToken(hoveredTokenEl, 'hover');
            });
            floatingLineText.addEventListener('mouseleave', () => {
                clearHoveredToken();
            });
            floatingLineText.addEventListener('click', async (e) => {
                const token = e.target?.closest?.('[data-token="1"]');
                if (!token) return;
                e.preventDefault();
                e.stopPropagation();
                setSelectedToken(token);
                const word = (token.textContent || '').trim();
                if (!word) return;
                await showWordByWordExplanation(word, null, token);
            });

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

    function clearHoveredToken() {
        if (!hoveredTokenEl) return;
        if (hoveredTokenEl !== selectedTokenEl) paintToken(hoveredTokenEl, 'none');
        hoveredTokenEl = null;
    }

    function setSelectedToken(el) {
        if (selectedTokenEl && selectedTokenEl !== el) paintToken(selectedTokenEl, 'none');
        selectedTokenEl = el || null;
        if (selectedTokenEl) paintToken(selectedTokenEl, 'selected');
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
        setSelectedToken(null);
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

    async function fetchAIWordByWordExplanation(text) {
        const cacheKey = `ai:${text.trim()}`;
        if (explainCache.has(cacheKey)) return explainCache.get(cacheKey);

        const res = await chrome.runtime.sendMessage({ type: 'ai:explain', text });
        if (!res?.ok) {
            throw new Error(res?.error || 'AI explanation failed. Please check helper settings.');
        }

        const items = Array.isArray(res.items) ? res.items : [];
        explainCache.set(cacheKey, items);
        return items;
    }

    async function fetchDictionaryFirst(text) {
        const cacheKey = `dict:${text.trim()}`;
        if (explainCache.has(cacheKey)) return explainCache.get(cacheKey);

        const res = await chrome.runtime.sendMessage({ type: 'dict:lookup', text });
        if (!res?.ok) {
            throw new Error(res?.error || 'Dictionary lookup failed.');
        }

        const items = Array.isArray(res.items) ? res.items : [];
        explainCache.set(cacheKey, items);
        return items;
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
        if (explainDialog) explainDialog.style.display = 'none';
        try {
            const sel = window.getSelection?.();
            if (sel && sel.removeAllRanges) sel.removeAllRanges();
        } catch (_) {}
        clearHoveredToken();
        setSelectedToken(null);
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

        try {
            const dictItems = await fetchDictionaryFirst(text);
            dictList.innerHTML = renderExplainItems(dictItems);
        } catch (err) {
            dictList.innerHTML = `Dictionary error: ${(err?.message || 'Failed').replace(/</g, '&lt;')}`;
        }
        positionExplainDialogNearSelection(dialog, selection, anchorEl);

        if (aiBtn) {
            aiBtn.onclick = async () => {
                aiBtn.disabled = true;
                aiStatus.textContent = 'Thinking...';
                list.innerHTML = '';
                try {
                    const items = await fetchAIWordByWordExplanation(text);
                    list.innerHTML = `<div style="font-weight:600;margin-bottom:4px;">AI</div>${renderExplainItems(items)}`;
                    aiStatus.textContent = '';
                    positionExplainDialogNearSelection(dialog, selection, anchorEl);
                } catch (err) {
                    list.innerHTML = `AI error: ${(err?.message || 'Failed').replace(/</g, '&lt;')}`;
                    aiStatus.textContent = '';
                } finally {
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
            const text = (selection?.toString() || '').trim();
            if (!text) return;

            const anchorNode = selection.anchorNode;
            const anchorElement = anchorNode?.nodeType === 1 ? anchorNode : anchorNode?.parentElement;
            const inTranscript = !!anchorElement?.closest?.('#yt-current-line-window, ytd-transcript-renderer, ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"], ytd-transcript-segment-renderer');
            if (!inTranscript) return;

            await showWordByWordExplanation(text, selection, anchorElement);
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeExplainDialog();
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
