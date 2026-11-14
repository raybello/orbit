import type { Bot, BotComputerStatus } from '@orbit/contracts';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { useStore } from '../store';
import { ScreenFrame, useScreenPreview } from './ScreenPreview';

/** Badge copy per server status. 'Awake' is the only one that means the computer is usable now. */
const STATUS_LABEL: Record<BotComputerStatus['status'], string> = {
  awake: 'Awake',
  sleeping: 'Sleeping',
  starting: 'Starting',
  unknown: 'Unknown',
};

const KIND_LABEL: Record<BotComputerStatus['kind'], string> = {
  docker: 'Docker',
  orgo: 'Orgo',
  none: '',
};

interface Props {
  bot: BotComputerStatus;
  onOpen: (botId: string) => void;
}

/**
 * One bot's computer: who it belongs to, whether it is awake, and the way into the large viewer.
 *
 * The preview is a still of the screen, refreshed on a timer, rather than a live `<ComputerScreen>`:
 * that component streams a noVNC relay connection per mount, so a grid of cards would open one
 * stream (and one of the computer's limited screens) for every bot just by being looked at. A still
 * is always on — nobody should have to ask for a preview of a screen that exists.
 */
export function ComputerCard({ bot, onOpen }: Props) {
  const full = useStore((s) => s.bots.find((b) => b.id === bot.botId));
  const status = STATUS_LABEL[bot.status] ?? 'Unknown';
  const canOpen = bot.vncAvailable;
  const kind = KIND_LABEL[bot.kind] ?? '';
  // Nothing to photograph while the computer is asleep or gone; the last frame stays on screen.
  const live = bot.status === 'awake' || bot.status === 'starting';
  const { src } = useScreenPreview(bot.botId, { enabled: live });

  // The roster can lag behind /computers; a neutral avatar keeps the card from shifting shape.
  const avatar: Pick<Bot, 'avatarShape' | 'avatarColor' | 'name'> = full ?? {
    avatarShape: 'blob',
    avatarColor: 'gray',
    name: bot.botName,
  };

  const open = () => onOpen(bot.botId);

  return (
    <article className={`computer-card is-${bot.status}`} aria-label={`${bot.botName}’s computer`}>
      <header className="computer-card__head">
        <span className="computer-card__avatar">
          <BotAvatarFor bot={avatar} size={26} />
        </span>
        <span className="computer-card__name" title={bot.botName}>{bot.botName}</span>
        <span className={`computer-card__badge is-${bot.status}`}>
          <i className="computer-card__dot" aria-hidden />
          {status}
        </span>
      </header>

      <button
        type="button"
        className={`computer-card__preview is-${bot.status}`}
        onClick={open}
        disabled={!canOpen}
        aria-label={`Preview ${bot.botName}’s computer`}
        title={canOpen ? `Open ${bot.botName}’s computer` : 'This computer has no screen to show'}
      >
        <span className="computer-card__frame" aria-hidden>
          <span className="computer-card__frame-bar">
            <i /><i /><i />
          </span>
          <span className="computer-card__frame-body">
            <ScreenFrame src={src} bot={avatar} size={30} />
          </span>
        </span>
        <span className="computer-card__caption">
          {canOpen ? (bot.status === 'awake' ? 'Screen ready' : `Screen ${status.toLowerCase()}`) : 'No screen'}
        </span>
        {bot.isRunning && (
          <span className="computer-card__chip">
            <i className="computer-card__chip-dot" aria-hidden />
            Working
          </span>
        )}
      </button>

      <footer className="computer-card__foot">
        <span className="computer-card__kind">{kind}</span>
        <button
          type="button"
          className="computer-card__open"
          onClick={open}
          disabled={!canOpen}
          aria-label={canOpen ? `Open ${bot.botName}’s computer` : undefined}
        >
          {canOpen ? 'Open' : 'No screen'}
        </button>
      </footer>
    </article>
  );
}
