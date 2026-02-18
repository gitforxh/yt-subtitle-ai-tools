(() => {
  const MAX_ATTEMPTS = 30;
  const RETRY_MS = 500;

  function getYtCfgValue(key) {
    try {
      if (typeof window.ytcfg !== 'undefined') {
        return window.ytcfg.get?.(key) || window.ytcfg.data_?.[key] || '';
      }
    } catch (_) {}
    return '';
  }

  function findCaptionData() {
    let captionTracks = [];
    let videoTitle = document.title || 'Video';

    try {
      const moviePlayer = document.getElementById('movie_player');
      const playerResponse =
        moviePlayer?.getPlayerResponse?.() ||
        window.ytInitialPlayerResponse ||
        window.ytplayer?.config?.args?.player_response;

      const normalizedResponse =
        typeof playerResponse === 'string' ? JSON.parse(playerResponse) : playerResponse;

      videoTitle = normalizedResponse?.videoDetails?.title || videoTitle;
      captionTracks =
        normalizedResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    } catch (_) {}

    const data = {
      captionTracks,
      videoTitle,
      apiKey: getYtCfgValue('INNERTUBE_API_KEY'),
      visitorData: getYtCfgValue('VISITOR_DATA'),
      clientVersion: getYtCfgValue('INNERTUBE_CONTEXT_CLIENT_VERSION') || '2.20240320.00.00'
    };

    return data;
  }

  function postResult(data) {
    if (Array.isArray(data.captionTracks) && data.captionTracks.length > 0) {
      window.postMessage({ type: 'YOUTUBE_SUBTITLES_DATA', ...data }, '*');
      return true;
    }
    return false;
  }

  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    const data = findCaptionData();

    if (postResult(data) || attempts >= MAX_ATTEMPTS) {
      clearInterval(timer);
      if (!data.captionTracks?.length) {
        window.postMessage({ type: 'YOUTUBE_SUBTITLES_NOT_FOUND' }, '*');
      }
    }
  }, RETRY_MS);
})();
