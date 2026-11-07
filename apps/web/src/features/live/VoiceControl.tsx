import { useEffect, useRef, useState } from 'react';
import { Mic, Square } from 'lucide-react';
import { runVoiceCommand, voiceCommandExamples } from '../../lib/live-ui';
import styles from './VoiceControl.module.scss';

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult:
    | ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void)
    | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}
type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};
const getRecognition = () =>
  (window as SpeechWindow).SpeechRecognition ?? (window as SpeechWindow).webkitSpeechRecognition;

const HINT = 'Try “next feed”, “screen two” or “show me tennis”.';
const FALLBACK_EXAMPLES = ['Next feed', 'Screen two', 'Show me tennis', 'Mute / unmute'];
const BUBBLE_MS = 5000;

/** Minimal mic button for the header; results show briefly in a bubble beneath it. */
export function VoiceControl() {
  const [listening, setListening] = useState(false);
  const [message, setMessageState] = useState(HINT);
  const [bubble, setBubble] = useState(false);
  const [interim, setInterim] = useState('');
  const [examples, setExamples] = useState<string[] | null>(null);
  const bubbleTimer = useRef<ReturnType<typeof setTimeout>>();
  const showExamples = () => {
    const list = voiceCommandExamples();
    setExamples(list.length ? list : FALLBACK_EXAMPLES);
  };
  const setMessage = (text: string, withExamples = false) => {
    setMessageState(text);
    if (withExamples) showExamples();
    else setExamples(null);
    setBubble(true);
    clearTimeout(bubbleTimer.current);
  };
  const active = useRef<Recognition | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      clearTimeout(bubbleTimer.current);
      const recognition = active.current;
      active.current = null;
      if (recognition) {
        recognition.onend = recognition.onerror = recognition.onresult = null;
        recognition.abort();
      }
    },
    [],
  );

  useEffect(() => {
    if (!bubble || listening) return;
    bubbleTimer.current = setTimeout(() => setBubble(false), examples ? BUBBLE_MS * 2 : BUBBLE_MS);
    return () => clearTimeout(bubbleTimer.current);
  }, [bubble, listening, message, examples]);

  const stop = () => {
    const recognition = active.current;
    active.current = null;
    clearTimeout(timer.current);
    recognition?.abort();
    setListening(false);
  };
  const toggle = () => {
    if (active.current) {
      stop();
      setMessage('Listening cancelled.');
      return;
    }
    const Constructor = getRecognition();
    if (!Constructor) return;
    const recognition = new Constructor();
    active.current = recognition;
    recognition.lang = 'en-GB';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 5;
    let received = false;
    recognition.onresult = (event) => {
      if (active.current !== recognition || received) return;
      const result = event.results[0];
      if (!result) return;
      const alternatives = Array.from(result, (alt) => alt.transcript.trim()).filter(Boolean);
      if (!alternatives.length) return;
      if (!result.isFinal) {
        setInterim(alternatives[0]!);
        return;
      }
      received = true;
      const { reply, ok, understood } = runVoiceCommand(alternatives);
      const heard = understood ? `“${alternatives[0]}” → ${understood}` : `“${alternatives[0]}”`;
      setMessage(`${heard} — ${reply}`, !ok);
      stop();
    };
    recognition.onerror = (event) => {
      if (active.current !== recognition) return;
      received = true;
      setMessage(
        event.error === 'not-allowed' || event.error === 'service-not-allowed'
          ? 'Microphone access was denied. Allow it in your browser settings and try again.'
          : event.error === 'audio-capture'
            ? 'No microphone is available. Connect one and try again.'
            : event.error === 'network'
              ? 'Speech recognition could not connect. Check your connection and retry.'
              : 'Could not hear a command. Tap the mic to try again.',
        event.error === 'no-speech',
      );
      stop();
    };
    recognition.onend = () => {
      if (active.current !== recognition) return;
      active.current = null;
      clearTimeout(timer.current);
      setListening(false);
      if (!received) setMessage('No command heard. Tap the mic to try again.', true);
    };
    try {
      recognition.start();
      setListening(true);
      setInterim('');
      setMessage('Listening… say a command, or tap again to cancel.', true);
      timer.current = setTimeout(() => {
        stop();
        setMessage('Listening timed out. Tap the mic to try again.', true);
      }, 12000);
    } catch {
      stop();
      setMessage('Could not start the microphone. Try again.');
    }
  };
  if (!getRecognition()) return null;
  return (
    <div className={styles.control}>
      <button
        type="button"
        className={`${styles.mic} ${listening ? styles.listening : ''}`}
        onClick={toggle}
        aria-pressed={listening}
        aria-label={listening ? 'Cancel voice command' : 'Voice command'}
        aria-describedby="voice-status"
        title={listening ? 'Listening — tap to cancel' : `Voice command. ${HINT}`}
      >
        {listening ? <Square size={14} fill="currentColor" /> : <Mic size={18} />}
      </button>
      <span id="voice-status" role="status" className={bubble ? styles.bubble : 'sr-only'}>
        {message}
        {listening && interim && <span className={styles.interim}>“{interim}”</span>}
        {examples && (
          <span className={styles.examples}>
            <span className={styles.examplesLabel}>{listening ? 'You can say' : 'Try saying'}</span>
            <span className={styles.chips}>
              {examples.map((example) => (
                <span key={example} className={styles.chip}>
                  {example}
                </span>
              ))}
            </span>
          </span>
        )}
        {listening && (
          <span className={styles.notice}>Your browser’s speech service may process audio.</span>
        )}
      </span>
    </div>
  );
}
