if (!window.isSecureContext) {
    alert('This page must be served over HTTPS or from localhost to enable WebRTC features.');
}

// ====== DOM ======
const $ = (id) => document.getElementById(id);
const wsUriEl      = $('wsUri');
const sipUriEl     = $('sipUri');
const pwdEl        = $('password');
const calleeEl     = $('callee');

const btnRegister  = $('btnRegister');
const btnUnregister= $('btnUnregister');
const btnCall      = $('btnCall');
const btnAnswer    = $('btnAnswer');
const btnHangup    = $('btnHangup');

const uaStatusEl   = $('uaStatus');
const callStatusEl = $('callStatus');
const logEl        = $('log');
const canvas       = $('spectrum');
const ctx2d        = canvas.getContext('2d');
const remoteAudio  = $('remoteAudio');

// ====== State ======
let ua = null;                    // JsSIP.UA
let currentSession = null;        // JsSIP.RTCSession
let sessionDirection = null;      // 'incoming' | 'outgoing' | null
let sessionEstablished = false;   // true after accepted/confirmed
let audioCtx = null;              // AudioContext
let analyser = null;              // AnalyserNode (remote)
let remoteSrcNode = null;         // MediaStreamAudioSourceNode
let rafId = 0;                    // requestAnimationFrame id

// Outgoing synthetic "ding" generator
let osc = null;                   // OscillatorNode
let gain = null;                  // GainNode
let outDest = null;               // MediaStreamAudioDestinationNode
let dingTimer = 0;                // setInterval id
const DING_PERIOD_MS = 1000;      // one "ding" per second
const DING_FREQ_HZ   = 880;       // tone frequency
const DING_ATTACK_S  = 0.01;      // envelope attack
const DING_DECAY_S   = 0.8;       // envelope decay

// ====== Utilities ======
function log(...args) {
    const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
    const msg = args.map(a => {
        if (a instanceof Error) return (a.stack || a.message || String(a));
        if (typeof a === 'object') {
            try { return JSON.stringify(a, null, 2); } catch { return String(a); }
        }
        return String(a);
    }).join(' ');
    console.log('[LOG]', msg);
    const line = `[${ts}] ${msg}\n`;
    logEl.textContent += line;
    logEl.scrollTop = logEl.scrollHeight;
}

function setUAStatus(text) { uaStatusEl.textContent = text; }
function setCallStatus(text) { callStatusEl.textContent = text; }

// Persist inputs
const LS_KEYS = {
    ws: 'webrtc_test_ws_uri',
    sip: 'webrtc_test_sip_uri',
    pwd: 'webrtc_test_pwd',
    callee: 'webrtc_test_callee',
};
function loadFromStorage() {
    try {
        wsUriEl.value  = localStorage.getItem(LS_KEYS.ws)     || '';
        sipUriEl.value = localStorage.getItem(LS_KEYS.sip)    || '';
        pwdEl.value    = localStorage.getItem(LS_KEYS.pwd)    || '';
        calleeEl.value = localStorage.getItem(LS_KEYS.callee) || '';
    } catch {}
}
function bindAutoSave(el, key) {
    el.addEventListener('change', () => { try { localStorage.setItem(key, el.value.trim()); } catch {} });
    el.addEventListener('input',  () => { try { localStorage.setItem(key, el.value.trim()); } catch {} });
}

// Centralized UI control: buttons always reflect UA registration state
function updateUI() {
    const isReg = !!ua && !!ua.isRegistered && ua.isRegistered();
    const hasSession = !!currentSession;
    const canAnswer = hasSession && sessionDirection === 'incoming' && !sessionEstablished;

    btnRegister.disabled   = isReg;                 // disabled if already registered
    btnUnregister.disabled = !isReg;                // enabled only if registered
    btnCall.disabled       = !isReg || hasSession;  // need registration and no active session
    btnAnswer.disabled     = !canAnswer;            // only for pending incoming calls
    btnHangup.disabled     = !hasSession;           // only when a session exists
}

function ensureAudioContext() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        log('AudioContext created, sampleRate=', audioCtx.sampleRate);
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(err => log('AudioContext resume failed:', err));
    }
    return audioCtx;
}

// Synthetic "ding" generator
function startDingGenerator() {
    ensureAudioContext();
    if (!outDest) outDest = audioCtx.createMediaStreamDestination();
    if (!gain) {
        gain = audioCtx.createGain();
        gain.gain.value = 0.0;
        gain.connect(outDest);
    }
    if (!osc) {
        osc = audioCtx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = DING_FREQ_HZ;
        osc.connect(gain);
        osc.start();
        log('Oscillator started at', DING_FREQ_HZ, 'Hz');
    }
    if (!dingTimer) {
        dingTimer = setInterval(() => {
            const now = audioCtx.currentTime;
            try {
                gain.gain.cancelScheduledValues(now);
                gain.gain.setValueAtTime(0.0001, now);
                gain.gain.exponentialRampToValueAtTime(1.0, now + DING_ATTACK_S);
                gain.gain.exponentialRampToValueAtTime(0.0001, now + DING_ATTACK_S + DING_DECAY_S);
            } catch {
                gain.gain.cancelScheduledValues(now);
                gain.gain.setValueAtTime(0.0, now);
                gain.gain.linearRampToValueAtTime(1.0, now + DING_ATTACK_S);
                gain.gain.linearRampToValueAtTime(0.0, now + DING_ATTACK_S + DING_DECAY_S);
            }
        }, DING_PERIOD_MS);
        log('Ding generator started: period=', DING_PERIOD_MS, 'ms');
    }
}
function stopDingGenerator() {
    if (dingTimer) { clearInterval(dingTimer); dingTimer = 0; }
    log('Ding generator stopped (envelope timer cleared).');
}
function getOutgoingMediaStream() {
    startDingGenerator();
    return outDest.stream;
}

// FFT visualization (remote audio)
function startSpectrum(stream) {
    ensureAudioContext();
    stopSpectrum(); // cleanup if needed

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;

    remoteSrcNode = audioCtx.createMediaStreamSource(stream);
    remoteSrcNode.connect(analyser);

    const freqBins = analyser.frequencyBinCount;
    const data = new Uint8Array(freqBins);

    function draw() {
        ctx2d.clearRect(0, 0, canvas.width, canvas.height);

        analyser.getByteFrequencyData(data);
        const W = canvas.width;
        const H = canvas.height;
        const pad = 20;
        const usableW = W - pad * 2;
        const usableH = H - pad * 2;
        const barCount = Math.min(freqBins, 256);
        const barW = usableW / barCount;

        ctx2d.strokeStyle = '#888';
        ctx2d.lineWidth = 1;
        ctx2d.beginPath();
        ctx2d.moveTo(pad, H - pad);
        ctx2d.lineTo(W - pad, H - pad);
        ctx2d.moveTo(pad, pad);
        ctx2d.lineTo(pad, H - pad);
        ctx2d.stroke();

        for (let i = 0; i < barCount; i++) {
            const magnitude = data[i] / 255;
            const barH = magnitude * usableH;
            const x = pad + i * barW;
            const y = H - pad - barH;
            const hue = 180 + (1 - magnitude) * 140;
            ctx2d.fillStyle = `hsl(${hue}, 70%, ${30 + magnitude * 30}%)`;
            ctx2d.fillRect(x, y, Math.max(1, barW * 0.9), barH);
        }
        rafId = requestAnimationFrame(draw);
    }

    draw();
    log('Spectrum visualizer started.');
}
function stopSpectrum() {
    if (rafId) cancelAnimationFrame(rafId), rafId = 0;
    if (remoteSrcNode) { try { remoteSrcNode.disconnect(); } catch {} remoteSrcNode = null; }
    if (analyser) { try { analyser.disconnect(); } catch {} analyser = null; }
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
}

// ====== SIP helpers ======
function normalizeSipUri(input) {
    if (!input) return '';
    let s = input.trim();
    if (s.toLowerCase().startsWith('sip:')) return s;
    if (s.includes('@')) return 'sip:' + s;
    return '';
}
function extractDomainFromSipUri(sipUri) {
    const u = normalizeSipUri(sipUri);
    if (!u) return '';
    const at = u.indexOf('@');
    if (at < 0) return '';
    const domainPart = u.slice(at + 1);
    const stop = Math.min(
        ...[domainPart.indexOf(';'), domainPart.indexOf('>'), -1].filter(x => x >= 0).concat([domainPart.length])
    );
    return domainPart.slice(0, stop);
}
function buildTargetFromCallee(callee, defaultDomain) {
    let s = (callee || '').trim();
    if (!s) return '';
    if (!s.toLowerCase().startsWith('sip:')) {
        if (!s.includes('@')) {
            if (!defaultDomain) return '';
            s = `sip:${s}@${defaultDomain}`;
        } else {
            s = `sip:${s}`;
        }
    }
    return s;
}

// ====== JsSIP UA and session handlers ======
function attachUAHandlers(uaInstance) {
    uaInstance.on('connected', () => {
        setUAStatus('WebSocket connected');
        log('UA connected (WebSocket up)');
        updateUI();
    });
    uaInstance.on('disconnected', (e) => {
        setUAStatus('disconnected');
        log('UA disconnected:', (e && e.reason) || '');
        updateUI(); // Register button state strictly follows registration status
    });
    uaInstance.on('registered', () => {
        setUAStatus('registered');
        log('Registered');
        updateUI();
    });
    uaInstance.on('unregistered', (e) => {
        setUAStatus('unregistered');
        log('Unregistered', e && e.cause ? `cause=${e.cause}` : '');
        updateUI();
    });
    uaInstance.on('registrationFailed', (e) => {
        setUAStatus('registration failed');
        log('Registration failed:', (e && (e.cause || (e.response && e.response.reason_phrase))) || e);
        updateUI();
    });

    uaInstance.on('newRTCSession', (e) => {
        const session = e.session;
        currentSession = session;
        sessionDirection = (e.originator === 'local') ? 'outgoing' : 'incoming';
        sessionEstablished = false;
        setCallStatus(sessionDirection === 'outgoing' ? 'calling' : 'incoming');
        log('New RTC session. direction=', sessionDirection);

        let sessionConnectionHandled = false;
        function attachSessionConnectionHandlers(pc) {
            log('PeerConnection ready on newRTCSession.');
            pc.addEventListener('iceconnectionstatechange', () => { log('ICE state:', pc.iceConnectionState); });
            pc.addEventListener('connectionstatechange', () => { log('PC state:', pc.connectionState); });
            pc.addEventListener('signalingstatechange', () => { log('Signaling state:', pc.signalingState); });
            pc.addEventListener('track', (ev) => {
                const [remoteStream] = ev.streams || [];
                log('Remote track added. kind=', ev.track && ev.track.kind, 'streams=', (ev.streams || []).length);
                if (remoteStream) {
                    try {
                        remoteAudio.srcObject = remoteStream;
                        const p = remoteAudio.play();
                        if (p && typeof p.then === 'function') {
                            p.then(() => log('Remote audio playing (muted).'))
                                .catch(err => log('remoteAudio.play() rejected:', err));
                        }
                    } catch (err) {
                        log('Error attaching remote stream to audio element:', err);
                    }
                    startSpectrum(remoteStream); // visualize
                }
            });
        }

        // Basic session lifecycle
        session.on('connecting', () => { log('Session connecting...'); });
        session.on('progress', () => { setCallStatus('progress / early media'); log('Session progress (180/183)'); updateUI(); });
        session.on('accepted', () => { setCallStatus('accepted'); sessionEstablished = true; log('Session accepted'); updateUI(); });
        session.on('confirmed', () => { setCallStatus('in-call'); sessionEstablished = true; log('Session confirmed (DTLS established)'); updateUI(); });
        session.on('ended', (data) => {
            setCallStatus('ended');
            log('Session ended:', (data && data.cause) || '');
            currentSession = null;
            sessionDirection = null;
            sessionEstablished = false;
            stopSpectrum();
            stopDingGenerator();
            updateUI(); // Do not flip Register; it follows UA registration state
        });
        session.on('failed', (data) => {
            setCallStatus('failed');
            log('Session failed:', (data && data.cause) || '');
            currentSession = null;
            sessionDirection = null;
            sessionEstablished = false;
            stopSpectrum();
            stopDingGenerator();
            updateUI(); // Do not flip Register; it follows UA registration state
        });

        session.on('peerconnection', (ev) => {
            const pc = session.connection || ev.peerconnection || ev.pc;
            log('PeerConnection created (peerconnection event). Attaching handlers.');
            if (!sessionConnectionHandled) {
                sessionConnectionHandled = true;
                attachSessionConnectionHandlers(pc);
            }
        });

        // Attach RTCPeerConnection listeners directly here and handle 'track' on session.connection
        if (session.connection) {
            sessionConnectionHandled = true;
            attachSessionConnectionHandlers(session.connection);
        } else {
            log('Warning: session.connection is not available on newRTCSession.');
        }

        updateUI();
    });
}

// ====== Actions ======
function doRegister() {
    ensureAudioContext(); // unlock on user gesture
    const wsUri = wsUriEl.value.trim();
    const sipUserUri = normalizeSipUri(sipUriEl.value);
    const password = pwdEl.value;

    if (!/^wss?:\/\//i.test(wsUri)) { log('Please enter a valid WebSocket URL (e.g., wss://host/ws)'); return; }
    if (!sipUserUri) { log('Please enter a valid SIP URI (e.g., 1001@example.com or sip:1001@example.com)'); return; }
    if (!password) { log('Warning: password is empty; registration may fail.'); }

    try {
        const socket = new JsSIP.WebSocketInterface(wsUri);
        const configuration = {
            sockets: [socket],
            uri: sipUserUri,
            password: password,
            register: true,
            session_timers: false,
        };

        if (ua) {
            try { ua.stop(); } catch {}
            ua = null;
        }

        ua = new JsSIP.UA(configuration);
        attachUAHandlers(ua);
        ua.start();
        setUAStatus('starting...');
        log('UA start. ws=', wsUri, ' uri=', sipUserUri);
        updateUI(); // Register button follows isRegistered; may still be enabled until 'registered'
    } catch (e) {
        log('Failed to create UA:', e);
        updateUI();
    }
}

function doUnregister() {
    if (!ua) return;
    try {
        ua.unregister({ all: true });
        log('Unregister requested.');
    } catch (e) {
        log('Unregister error:', e);
    } finally {
        updateUI();
    }
}

function doCall() {
    if (!ua) { log('UA not started'); return; }
    const defaultDomain = extractDomainFromSipUri(sipUriEl.value);
    const target = buildTargetFromCallee(calleeEl.value, defaultDomain);
    if (!target) { log('Invalid callee. Enter number, number@domain, or sip:number@domain'); return; }

    const localStream = getOutgoingMediaStream();
    const options = {
        eventHandlers: {
            progress: () => log('Call progress...'),
            failed:   (e) => log('Call failed:', (e && e.cause) || ''),
            ended:    (e) => log('Call ended:', (e && e.cause) || ''),
            confirmed:() => log('Call confirmed.'),
        },
        mediaStream: localStream, // send synthetic tone
        pcConfig: {
            // iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        },
        rtcOfferConstraints: {
            offerToReceiveAudio: true,
            offerToReceiveVideo: false,
        },
        sessionTimers: false,
    };

    try {
        ua.call(target, options);
        setCallStatus('calling');
        log('Dialing:', target);
    } catch (e) {
        log('Failed to start call:', e);
    } finally {
        updateUI();
    }
}

function doAnswer() {
    if (!currentSession || sessionDirection !== 'incoming' || sessionEstablished) {
        log('No pending incoming call to answer.');
        return;
    }
    const localStream = getOutgoingMediaStream();
    try {
        currentSession.answer({
            mediaStream: localStream, // send synthetic tone on answer
            pcConfig: {
                // iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
            },
            rtcOfferConstraints: {
                offerToReceiveAudio: true,
                offerToReceiveVideo: false,
            },
            sessionTimers: false,
        });
        setCallStatus('answering...');
        log('Answer requested.');
    } catch (e) {
        log('Answer error:', e);
    } finally {
        updateUI();
    }
}

function doHangup() {
    if (currentSession) {
        try {
            currentSession.terminate();
            log('Hangup requested.');
        } catch (e) {
            log('Hangup error:', e);
        } finally {
            updateUI();
        }
    } else {
        log('No active session.');
    }
}

// ====== Bind UI events ======
btnRegister.addEventListener('click', doRegister);
btnUnregister.addEventListener('click', doUnregister);
btnCall.addEventListener('click', doCall);
btnAnswer.addEventListener('click', doAnswer);
btnHangup.addEventListener('click', doHangup);

// ====== Init ======
loadFromStorage();
bindAutoSave(wsUriEl, LS_KEYS.ws);
bindAutoSave(sipUriEl, LS_KEYS.sip);
bindAutoSave(pwdEl, LS_KEYS.pwd);
bindAutoSave(calleeEl, LS_KEYS.callee);
updateUI();
log('Page loaded. Fill the fields and click "Register" or "Call".');
