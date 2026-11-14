import { useConfigUI } from '../configStore';
import { useStore } from '../store';
import { Icon } from './Icon';
import '../styles/calls.css';

/**
 * Calls is a placeholder. Voice already exists — it is the microphone in a chat's composer, and the
 * VoiceCallBar while a call is live — so this section says where to find it rather than pretending
 * to be a call surface of its own.
 */
export function CallsView() {
  const bots = useStore((s) => s.bots);
  const selectBot = useStore((s) => s.selectBot);
  const primary = bots.find((b) => b.isPrimary) ?? bots.find((b) => (b as { kind?: string }).kind !== 'room');

  const openChat = () => {
    if (!primary) return;
    useConfigUI.getState().setNavSection('chat');
    selectBot(primary.id);
  };

  return (
    <div className="calls">
      <div className="calls__badge">
        <Icon name="mic" size={22} />
      </div>
      <h2 className="calls__title">Calls are coming</h2>
      <p className="calls__text">
        Voice calls with your Bots are available today from any chat: press the microphone in the message
        box and talk to the Bot the way you would on a call.
      </p>
      <button type="button" className="calls__cta" onClick={openChat} disabled={!primary}>
        Open {primary ? `${primary.name}'s chat` : 'a chat'}
      </button>
      <p className="calls__hint">
        While a call is live, the voice bar sits above the composer with mute, hang up and the running
        transcript.
      </p>
    </div>
  );
}
