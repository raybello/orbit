import { useConfigUI } from '../../configStore';
import { AppSettings } from './AppSettings';
import { BotSettingsModal } from './BotSettingsModal';

export function ConfigLayer() {
  const botSettings = useConfigUI((s) => !!s.botSettings);
  const appSettings = useConfigUI((s) => !!s.appSettings);
  return (
    <>
      {appSettings && <AppSettings />}
      {botSettings && <BotSettingsModal />}
    </>
  );
}
