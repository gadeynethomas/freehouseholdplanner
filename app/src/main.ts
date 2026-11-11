import { mount } from 'svelte';
import App from './App.svelte';
import { t } from './lib/i18n.ts';
import './app.css';

const target = document.getElementById('app');
if (target === null) {
  throw new Error('index.html has no #app element');
}
document.title = t('app.title');
mount(App, { target });
