(function () {
    let subtitleWindow = null;
    let subtitleContent = null;
    let trackList = null;
    let currentTracks = [];

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

    function closeExplainDialog() {
        if (explainDialog) explainDialog.style.display = 'none';
        try {
            const sel = window.getSelection?.();
            if (sel && sel.removeAllRanges) sel.removeAllRanges();
        } catch (_) {}
        resumeVideoAfterExplain();
    }

    function positionExplainDialogNearSelection(dialog, selection) {
        const GAP = 10;
        const MARGIN = 8;

        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        const rect = range?.getBoundingClientRect?.();
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

    async function showWordByWordExplanation(text, selection) {
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

        positionExplainDialogNearSelection(dialog, selection);

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
        positionExplainDialogNearSelection(dialog, selection);

        if (aiBtn) {
            aiBtn.onclick = async () => {
                aiBtn.disabled = true;
                aiStatus.textContent = 'Thinking...';
                list.innerHTML = '';
                try {
                    const items = await fetchAIWordByWordExplanation(text);
                    list.innerHTML = `<div style="font-weight:600;margin-bottom:4px;">AI</div>${renderExplainItems(items)}`;
                    aiStatus.textContent = '';
                    positionExplainDialogNearSelection(dialog, selection);
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
            const inTranscript = !!anchorElement?.closest?.('ytd-transcript-renderer, ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"], ytd-transcript-segment-renderer');
            if (!inTranscript) return;

            await showWordByWordExplanation(text, selection);
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeExplainDialog();
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
                        const lines = data.events
                            .filter(event => event.segs)
                            .map(event => event.segs.map(s => s.utf8).join('').replace(/\n/g, ' '))
                            .filter(line => line.trim() !== '');

                        if (lines.length > 0) {
                            displaySubtitles(lines);
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
            const regex = /<text\s+[^>]*>([\s\S]*?)<\/text>/g;
            const lines = [];
            let match;
            while ((match = regex.exec(xmlText)) !== null) {
                lines.push(decodeEntities(match[1]));
            }

            if (lines.length > 0) {
                displaySubtitles(lines);
                return;
            }

            // Final fallback: scrape transcript panel from DOM
            const domLines = await extractFromTranscriptPanel();
            if (domLines.length > 0) {
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
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('inject.js');
        (document.head || document.documentElement).appendChild(script);
        script.onload = () => script.remove();
    }

    init();
    initSelectionExplain();

    window.addEventListener('yt-navigate-finish', () => {
        if (subtitleWindow) {
            subtitleContent.innerText = 'Loading...';
        }
        init();
    });
})();
