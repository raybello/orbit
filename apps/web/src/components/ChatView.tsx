import { useMemo, useState } from 'react';
import { botVars } from '../lib/colors';
import { sortedRows, useSelectedBot, useStore } from '../store';
import { Composer } from './Composer';
import { ConvHeader } from './ConvHeader';
import { FilesView } from './FilesView';
import { Transcript } from './Transcript';
import { VoiceCallBar } from './VoiceCallBar';

export function ChatView() {
  const bot = useSelectedBot();
  const transcript = useStore((s) => (bot ? s.transcripts[bot.id] : undefined));
  const live = useStore((s) => (bot ? s.live[bot.id] : undefined));
  const [toast, setToast] = useState<string | null>(null);
  const [chatTab, setChatTab] = useState<'chat' | 'files'>('chat');
  const rows = useMemo(() => sortedRows(transcript), [transcript]);

  if (!bot) {
    return (
      <main className="chat chat--empty">
        <div className="empty-chat"><div className="empty-chat__sub">No Bot selected.</div></div>
      </main>
    );
  }

  const flash = (t: string) => { setToast(t); setTimeout(() => setToast(null), 2000); };

  return (
    <main className="chat" style={botVars(bot.avatarColor)}>
      <ConvHeader bot={bot} running={!!live?.isRunning} activeTab={chatTab} onTabChange={setChatTab} onNotice={flash} />
      {chatTab === 'files' ? (
        <FilesView botId={bot.id} />
      ) : (
        <>
          <Transcript bot={bot} rows={rows} live={live} loaded={!!transcript?.loaded} />
          <VoiceCallBar />
          <Composer bot={bot} running={!!live?.isRunning} />
        </>
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
