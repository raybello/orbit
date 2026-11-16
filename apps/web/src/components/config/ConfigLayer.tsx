import { useConfigUI } from '../../configStore';
import { VoiceModelsModal } from '../voice/VoiceModelsModal';
import { VoiceSetupModal } from '../voice/VoiceSetupModal';
import { AppSettings } from './AppSettings';
import { BotSettingsModal } from './BotSettingsModal';

export function ConfigLayer() {
  const botSettings = useConfigUI((s) => !!s.botSettings);
  const appSettings = useConfigUI((s) => !!s.appSettings);
  const voiceModels = useConfigUI((s) => s.voiceModels);
  return (
    <>
      {appSettings && <AppSettings />}
      {botSettings && <BotSettingsModal />}
      {voiceModels && <VoiceModelsModal />}
      <VoiceSetupModal />
    </>
  );
}
