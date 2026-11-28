// The alert sound the admin panel plays when a new booking arrives. Made with the Web Audio API (no sound file to load).
// Browsers only allow sound after the person has clicked or typed on the page once, so the panel calls
// `unlockBookingSound` on the first interaction; until then a new booking is still shown, just silently.

const KEY = 'adminBookingSound';
let context = null;

export const isBookingSoundOn = () => {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
};

export const setBookingSoundOn = (on) => {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // the choice just is not remembered
  }
};

const audio = () => {
  if (typeof window === 'undefined') return null;
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) return null;
  if (!context) context = new Context();
  return context;
};

export const unlockBookingSound = () => {
  const ctx = audio();
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
};

/// True once the browser lets the panel make sound.
export const isBookingSoundReady = () => Boolean(context && context.state === 'running');

// A two-phrase chime, loud enough to notice from across the room.
const CHIME = [[880, 0], [1175, 0.16], [1568, 0.32], [880, 0.7], [1175, 0.86], [1568, 1.02]];

export const playBookingAlert = () => {
  if (!isBookingSoundOn()) return;
  const ctx = audio();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const now = ctx.currentTime;
  CHIME.forEach(([frequency, offset]) => {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, now + offset);
    gain.gain.exponentialRampToValueAtTime(0.4, now + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.3);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(now + offset);
    oscillator.stop(now + offset + 0.32);
  });
};
