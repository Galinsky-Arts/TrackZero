// Guest station page enhancement. Live playback needs an enrolled DRE station
// engine and authorized encrypted media; the page says so instead of faking audio.
const play = document.querySelector('[data-action="play"]');
const status = document.querySelector('[role="status"]');
if (play && status) {
  play.disabled = true;
  status.textContent = 'Live playback unavailable: this station has no enrolled station engine with authorized encrypted media yet.';
  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = 'When an engine is enrolled, Play joins the current broadcast position. TrackZero never offers a song picker.';
  status.after(note);
}
