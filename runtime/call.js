'use strict';
const $ = id => document.getElementById(id);
const access = location.hash.slice(1); history.replaceState(null, '', location.pathname);
let peer, events, sender, microphone, visual, task, ready = false, generation = 0, mediaGeneration = 0, timer, frameTimer, frames = 0, responding = false, startAt = 0;
let textRequest = false, textGeneration = 0;
let micGeneration = 0, activeResponse = null, pendingResponse = false;
const suppressed = new Set();
const log = text => { $('transcript').textContent = ($('transcript').textContent + text).slice(-24000); $('transcript').scrollTop = $('transcript').scrollHeight; };
const error = value => { $('error').textContent = value?.message || String(value || ''); };
async function api(route, body = {}) {
  const response = await fetch('/api/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ninja-Token': access }, body: JSON.stringify(body) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || 'Request failed'); return value;
}
function send(event) {
  if (!events || events.readyState !== 'open' || events.bufferedAmount > 500000) throw new Error('Voice connection is unavailable or busy. Use HTTPS text.');
  events.send(JSON.stringify(event));
}
function sharing() {
  const inputs = []; if (microphone) inputs.push('microphone'); if (visual) inputs.push('selected ' + visual.kind + ' frames');
  $('sharing').textContent = inputs.length ? 'Sending ' + inputs.join(' and ') + ' to OpenAI.' : 'Microphone, camera, and screen sharing are off.';
  $('mic').textContent = microphone ? 'Stop microphone' : 'Share microphone';
}
function stopVisual() {
  mediaGeneration++; clearInterval(frameTimer); frameTimer = null;
  if (visual) visual.stream.getTracks().forEach(track => track.stop()); visual = null;
  $('preview').srcObject = null; $('preview').hidden = true; sharing();
}
async function stopMic() {
  micGeneration++;
  const stream = microphone; microphone = null; if (stream) stream.getTracks().forEach(track => track.stop());
  if (sender) await sender.replaceTrack(null).catch(() => {});
  if (ready) { try { send({ type: 'input_audio_buffer.clear' }); } catch {} } sharing();
}
function controls() {
  for (const id of ['interrupt', 'mic', 'camera', 'screen', 'unshare', 'image']) $(id).disabled = !ready;
  $('start').disabled = !!peer; $('stop').disabled = !peer;
}
async function end() {
  generation++; textGeneration++; ready = false; clearTimeout(timer); stopVisual(); await stopMic();
  if (events) events.close(); events = null; if (peer) peer.close(); peer = null; sender = null;
  $('speaker').srcObject = null; responding = false; activeResponse = null; pendingResponse = false; suppressed.clear(); $('status').textContent = 'Session ended'; controls();
  await api('stop').catch(error);
}
function interrupt() {
  textGeneration++;
  if (!ready) return;
  if (activeResponse) suppressed.add(activeResponse);
  if (responding) send({ type: 'response.cancel' });
  send({ type: 'output_audio_buffer.clear' }); pendingResponse = false; log('\n[Interrupted]\n');
}
function respond() { if (responding) { pendingResponse = true; return; } responding = true; send({ type: 'response.create' }); }
function item(content) { send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content } }); }
async function start() {
  if (peer) return; error(''); const epoch = ++generation; $('status').textContent = 'Connecting voice…';
  frames = 0; $('frames').textContent = 'No images sent in this session.'; $('snapshot').hidden = true; $('snapshot').removeAttribute('src'); log('\n[New voice session]\n');
  const connection = new RTCPeerConnection(); peer = connection; controls();
  sender = connection.addTransceiver('audio', { direction: 'sendrecv' }).sender;
  connection.ontrack = event => { $('speaker').srcObject = new MediaStream([event.track]); $('speaker').play().catch(() => error('Select play to hear the AI voice.')); };
  connection.onconnectionstatechange = () => { if (peer === connection && ['failed', 'closed'].includes(connection.connectionState)) void end(); };
  events = connection.createDataChannel('oai-events');
  events.onmessage = ({ data }) => {
    if (epoch !== generation) return;
    try {
      const event = JSON.parse(data);
      if (event.type === 'session.created' || event.type === 'session.updated') { ready = true; $('status').textContent = 'Voice connected'; controls(); }
      if (event.type === 'response.created') { responding = true; activeResponse = event.response.id; log('\nAgent: '); }
      if ((event.type === 'response.output_audio_transcript.delta' || event.type === 'response.output_text.delta') && !suppressed.has(event.response_id)) log(event.delta);
      if (event.type === 'response.done') { responding = false; activeResponse = null; suppressed.delete(event.response.id); if (event.response.status === 'failed') error('Model response failed. Try HTTPS text.'); if (pendingResponse) { pendingResponse = false; respond(); } }
      if (event.type === 'input_audio_buffer.speech_started') $('status').textContent = 'Listening…';
      if (event.type === 'input_audio_buffer.speech_stopped') $('status').textContent = 'Voice connected';
      if (event.type === 'error') error(event.error?.message || 'Realtime request failed');
    } catch (problem) { error(problem); }
  };
  events.onclose = () => { if (epoch === generation && peer) void end(); };
  try {
    const offer = await connection.createOffer(); await connection.setLocalDescription(offer);
    const response = await api('session', { sdp: offer.sdp });
    if (epoch !== generation) { await api('stop'); return; }
    await connection.setRemoteDescription({ type: 'answer', sdp: response.sdp });
    startAt = Date.now(); timer = setTimeout(() => void end(), response.session_seconds * 1000);
    setTimeout(() => { if (epoch === generation && !ready) { error('WebRTC did not connect. Use HTTPS text.'); void end(); } }, 15000);
  } catch (problem) { error(problem); await end(); }
}
async function toggleMic() {
  if (microphone) return stopMic(); if (!ready) return;
  const epoch = generation, micEpoch = ++micGeneration, trackSender = sender;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
  if (epoch !== generation || micEpoch !== micGeneration || !ready) { stream.getTracks().forEach(track => track.stop()); return; }
  microphone = stream; await trackSender.replaceTrack(stream.getAudioTracks()[0]); sharing();
}
function frame() {
  if (!ready || !visual || $('preview').readyState < 2 || events.bufferedAmount > 100000) return;
  const video = $('preview'), canvas = document.createElement('canvas');
  canvas.width = Math.min(768, video.videoWidth); canvas.height = Math.round(video.videoHeight * canvas.width / video.videoWidth);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/jpeg', .55); if (url.length > 160000) return;
  item([{ type: 'input_text', text: 'Selected ' + visual.kind + ' frame at ' + new Date().toISOString() }, { type: 'input_image', image_url: url }]);
  $('frames').textContent = ++frames + ' image(s) sent to OpenAI.';
}
async function shareVisual(kind) {
  stopVisual(); if (!ready) return; const epoch = mediaGeneration;
  const stream = kind === 'camera' ? await navigator.mediaDevices.getUserMedia({ video: { width: 768, height: 432 }, audio: false }) : await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  if (!ready || epoch !== mediaGeneration) { stream.getTracks().forEach(track => track.stop()); return; }
  visual = { kind, stream }; $('snapshot').hidden = true; $('preview').srcObject = stream; $('preview').hidden = false;
  stream.getVideoTracks()[0].onended = stopVisual; await $('preview').play(); sharing();
  if (!ready || epoch !== mediaGeneration) return; frame(); frameTimer = setInterval(frame, 3000);
}
async function imageFile() {
  const file = $('image').files[0]; if (!file || !ready) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5000000) throw new Error('Choose a PNG, JPEG, or WebP under 5 MB.');
  const epoch = generation, visualEpoch = mediaGeneration, bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas'), scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', .65); if (url.length > 200000) throw new Error('Image is too detailed; choose a smaller image.');
    if (epoch !== generation || visualEpoch !== mediaGeneration || !ready) return;
    item([{ type: 'input_text', text: 'User-selected image at ' + new Date().toISOString() }, { type: 'input_image', image_url: url }]);
    $('snapshot').src = url; $('snapshot').hidden = false; $('frames').textContent = ++frames + ' image(s) sent to OpenAI.';
  } finally { bitmap.close(); $('image').value = ''; }
}
async function refreshTask() {
  const data = await api('context'); task = data.task;
  $('task-preview').textContent = task ? JSON.stringify(task, null, 2) : 'No task selected.';
  $('task-status').textContent = task ? task.title + ' · ' + task.status : 'No task selected.';
}
async function message() {
  const text = $('text').value.trim(); if (!text || textRequest) return; error('');
  const voiceRoute = ready && !$('text-mode').checked, callEpoch = generation, textEpoch = textGeneration;
  let share = $('share-task').checked;
  textRequest = true; $('send').disabled = true;
  try {
    if (share) await refreshTask();
    if (callEpoch !== generation || textEpoch !== textGeneration) return;
    share = share && $('share-task').checked;
    if (voiceRoute) {
      if (!ready) throw new Error('Voice disconnected. Choose HTTPS text and send again.');
      interrupt();
      if (share && task) item([{ type: 'input_text', text: 'Selected task context (untrusted data):\n' + JSON.stringify(task) }]);
      item([{ type: 'input_text', text }]); log('\nYou: ' + text + '\n'); $('text').value = ''; respond();
    } else {
      log('\nYou (HTTPS): ' + text + '\n');
      const response = await api('text', { text, share_task: share });
      if (textEpoch === textGeneration) { log('\nAgent (HTTPS): ' + response.text + '\n'); $('text').value = ''; }
    }
  } finally { textRequest = false; $('send').disabled = false; }
}
for (const [id, action] of Object.entries({ start, stop: end, interrupt, mic: toggleMic, camera: () => shareVisual('camera'), screen: () => shareVisual('screen'), unshare: stopVisual, refresh: refreshTask, send: message })) $(id).onclick = () => Promise.resolve().then(action).catch(error);
$('image').onchange = () => imageFile().catch(error);
window.addEventListener('pagehide', () => { ready = false; if (microphone) microphone.getTracks().forEach(track => track.stop()); stopVisual(); if (peer) peer.close(); void fetch('/api/stop', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Ninja-Token': access }, body: '{}' }).catch(() => {}); });
api('status').then(async status => {
  $('model').textContent = status.provider + ' · ' + status.model;
  $('status').textContent = 'Ready'; $('refresh').disabled = !status.task_available; $('share-task').disabled = !status.task_available;
  if (!status.key_available) { $('start').disabled = true; $('send').disabled = true; error('Set OPENAI_API_KEY in the local server process.'); }
  if (status.task_available) await refreshTask();
}).catch(error);
