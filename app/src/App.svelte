<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchAbout } from './lib/core.ts';
  import { t } from './lib/i18n.ts';

  let version = $state<string | null>(null);

  onMount(() => {
    fetchAbout()
      .then((about) => {
        version = about.version;
      })
      .catch(() => {
        // Outside the app (plain browser during UI work) there is no core to ask.
        version = null;
      });
  });
</script>

<main>
  <h1>{t('app.title')}</h1>
  <h2>{t('home.welcome')}</h2>
  <p>{t('home.empty')}</p>
  {#if version !== null}
    <p class="version">{t('app.version', { version })}</p>
  {/if}
</main>

<style>
  main {
    max-width: 48rem;
    margin: 0 auto;
    padding: max(1rem, env(safe-area-inset-top)) 1rem 1rem;
  }

  .version {
    color: var(--muted);
    font-size: 0.875rem;
  }
</style>
