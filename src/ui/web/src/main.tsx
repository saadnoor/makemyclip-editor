import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { CutApp } from './cut/CutApp.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('No #root element');
createRoot(root).render(
  <StrictMode>{location.pathname.startsWith('/cut') ? <CutApp /> : <App />}</StrictMode>,
);
