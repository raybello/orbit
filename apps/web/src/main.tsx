import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { hasNativeWindowControls } from './lib/desktop-shell';
import './styles/tokens.css';
import './styles/base.css';
import './styles/page.css';
import './styles/shell.css';
import './styles/chat.css';
import './styles/cards.css';
import './styles/details.css';
import './styles/artifact.css';
import './styles/modals.css';
import './styles/viewer.css';
import './styles/voice.css';

// Full-window layers read this to keep clear of the window buttons (styles/base.css).
if (hasNativeWindowControls()) document.documentElement.setAttribute('data-native-controls', '');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
