const fs = require('fs');

const html = fs.readFileSync('video_page.html', 'utf8');
const regex = /var ytInitialPlayerResponse = (\{.*?\});/;
const match = html.match(regex);

if (match) {
    try {
        const json = JSON.parse(match[1]);
        if (json.captions) {
            console.log('Captions found.');
            if (json.captions.playerCaptionsTracklistRenderer) {
                const tracks = json.captions.playerCaptionsTracklistRenderer.captionTracks;
                console.log(`Number of tracks: ${tracks ? tracks.length : 0}`);
                if (tracks) {
                    console.log('First track:', JSON.stringify(tracks[0], null, 2));
                }
            } else {
                console.log('playerCaptionsTracklistRenderer NOT found in captions');
                console.log('Captions keys:', Object.keys(json.captions));
            }
        } else {
            console.log('Captions property NOT found in ytInitialPlayerResponse');
            console.log('Keys available in root:', Object.keys(json));
        }

        console.log('PlayabilityStatus:', JSON.stringify(json.playabilityStatus, null, 2));

    } catch (e) {
        console.error('Failed to parse JSON:', e.message);
    }
} else {
    console.log('ytInitialPlayerResponse not found');
}
