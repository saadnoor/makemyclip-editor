import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { CutApp } from './cut/CutApp.js';
import { ProgressApp } from './progress/ProgressApp.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('No #root element');

function Screen() {
  if (location.pathname.startsWith('/cut')) return <CutApp />;
  if (location.pathname.startsWith('/progress')) return <ProgressApp />;
  return <App />;
}

createRoot(root).render(
  <StrictMode>
    <Screen />
  </StrictMode>,
);
