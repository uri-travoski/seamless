import React from 'react';
import { createRoot } from 'react-dom/client';
import { IconContext } from '@phosphor-icons/react';
import App from './App.tsx';
import './styles/app.css';
import { applyCachedAppearance } from './state/session.ts';

applyCachedAppearance();

if ('serviceWorker' in navigator && !import.meta.env.DEV) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js');
  });
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <IconContext.Provider value={{ weight: 'regular', size: 18 }}>
      <App />
    </IconContext.Provider>
  </React.StrictMode>,
);
