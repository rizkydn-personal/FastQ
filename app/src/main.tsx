import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: 'none' })
      .then((registration) => {
        void registration.update();
        const notifyWaitingWorker = () => {
          if (registration.waiting && navigator.serviceWorker.controller)
            window.dispatchEvent(new Event('fastq:sw-update'));
        };
        notifyWaitingWorker();
        registration.addEventListener('updatefound', () => {
          registration.installing?.addEventListener('statechange', notifyWaitingWorker);
        });
      })
      .catch(() => {});
  });
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
