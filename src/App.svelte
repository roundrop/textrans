<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { prefersReducedMotion } from 'svelte/motion';
  import { fade } from 'svelte/transition';
  import QRCode from 'qrcode';
  import Icon from './lib/Icon.svelte';
  import { TransferClient, initialState } from './lib/client';
  import { translate, errorText, type CopyKey, type Language } from './lib/i18n';
  import { INVITE_TTL, MAX_TEXT_BYTES } from '../shared/protocol';

  let language = $state<Language>('ja');
  let view = $state(initialState());
  let action = $state<'create' | 'join'>('create');
  let code = $state('');
  let codeFocused = $state(false);
  let showQr = $state(false);
  let draft = $state('');
  let qr = $state('');
  let notice = $state('');
  let copied = $state('');
  let dragging = $state(false);
  let sending = $state(false);
  let fileInput = $state<HTMLInputElement>();
  let textArea = $state<HTMLTextAreaElement>();
  let endDialog = $state<HTMLDialogElement>();
  let noticeTimeout: ReturnType<typeof setTimeout>;
  let copyTimeout: ReturnType<typeof setTimeout>;
  const client = new TransferClient((value) => {
    view = value;
  });
  const t = (key: CopyKey) => translate(language, key);
  const size = (bytes: number) =>
    bytes >= 1_000_000
      ? (bytes / 1_000_000).toFixed(1) + ' MB'
      : bytes >= 1000
        ? (bytes / 1000).toFixed(1) + ' KB'
        : bytes + ' B';
  const clock = (seconds: number) =>
    Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  const textBytes = $derived(new TextEncoder().encode(draft).length);
  // The host keeps the home layout while its invitation is open, so the code
  // appears in place instead of on a separate screen.
  const hosting = $derived(
    view.phase === 'waiting' && view.connection?.role === 'host' && !view.paired,
  );
  const home = $derived(view.phase === 'home' || view.phase === 'creating' || hosting);
  const secure = $derived(view.verified && view.peerVerified);
  const available = $derived(view.phase === 'connected');
  const busy = $derived(view.phase === 'creating');
  const canSend = $derived(available && !!draft.trim() && textBytes <= MAX_TEXT_BYTES && !sending);
  const screen = $derived(home ? 'home' : secure ? 'workspace' : view.phase);
  const statusKey = $derived<CopyKey>(
    available
      ? 'connected'
      : view.phase === 'reconnecting'
        ? 'reconnecting'
        : view.phase === 'verifying'
          ? 'verifyStatus'
          : view.phase === 'ended'
            ? 'ended'
            : 'waiting',
  );

  $effect(() => {
    document.documentElement.lang = language;
  });
  $effect(() => {
    if (view.phase === 'ended') {
      endDialog?.close();
      if (view.error === 'ended') draft = '';
    }
  });
  // Focus follows a change of task, never a progress update or incoming message.
  let previousScreen = 'home';
  $effect(() => {
    const next = screen;
    if (next !== previousScreen) {
      previousScreen = next;
      void tick().then(() =>
        document.querySelector<HTMLElement>('main h1')?.focus({ preventScroll: true }),
      );
    }
  });
  // A newly issued code replaces the button that created it, so focus moves to the code.
  let issuedCode = '';
  $effect(() => {
    const next = hosting ? view.connection?.code || '' : '';
    if (next === issuedCode) return;
    issuedCode = next;
    if (next)
      void tick().then(() =>
        document.getElementById('invite-code')?.focus({ preventScroll: true }),
      );
    else showQr = false;
  });
  $effect(() => {
    const url = view.inviteUrl;
    if (!url) {
      qr = '';
      return;
    }
    let current = true;
    QRCode.toDataURL(url, {
      width: 288,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#0b0b0c', light: '#ffffff' },
    }).then((value) => {
      if (current) qr = value;
    });
    return () => {
      current = false;
    };
  });
  onMount(() => {
    language = navigator.language.startsWith('ja') ? 'ja' : 'en';
    const fragment = new URLSearchParams(location.hash.slice(1));
    const inviteCode = fragment.get('code');
    const key = fragment.get('key');
    // Remove the secret from the address bar/history before doing any network work.
    if (location.hash) history.replaceState(null, '', location.pathname);
    if (inviteCode && /^\d{6}$/.test(inviteCode) && key && /^[A-Za-z0-9_-]{43}$/.test(key)) {
      action = 'join';
      void client.join(inviteCode, key);
    }
    const warnBeforeLeave = (event: BeforeUnloadEvent) => {
      if (draft.trim() || view.outgoing || view.incoming) event.preventDefault();
    };
    window.addEventListener('beforeunload', warnBeforeLeave);
    return () => {
      clearTimeout(noticeTimeout);
      clearTimeout(copyTimeout);
      window.removeEventListener('beforeunload', warnBeforeLeave);
      client.destroy();
    };
  });
  function flash(message: string) {
    clearTimeout(noticeTimeout);
    notice = message;
    noticeTimeout = setTimeout(() => {
      notice = '';
    }, 3500);
  }
  async function copy(value: string, id: string) {
    try {
      await navigator.clipboard.writeText(value);
      clearTimeout(copyTimeout);
      copied = id;
      copyTimeout = setTimeout(() => {
        copied = '';
      }, 2500);
      flash(t('copied'));
    } catch {
      flash(t('copyFailed'));
    }
  }
  async function paste() {
    try {
      draft = await navigator.clipboard.readText();
    } catch {
      flash(t('pasteFailed'));
    }
    textArea?.focus();
  }
  async function send() {
    if (!canSend) return;
    const value = draft;
    sending = true;
    try {
      if (await client.sendText(value)) {
        if (draft === value) draft = '';
        textArea?.focus();
      }
    } finally {
      sending = false;
    }
  }
  function create() {
    action = 'create';
    void client.create();
  }
  function join() {
    if (code.length !== 6 || busy) return;
    action = 'join';
    void client.join(code);
  }
  function end() {
    endDialog?.close();
    client.end();
    draft = '';
    code = '';
    copied = '';
    notice = '';
  }
  function requestEnd() {
    if (draft.trim() || view.history.length || view.outgoing || view.incoming)
      endDialog?.showModal();
    else end();
  }
  function urlOf(value: string) {
    try {
      const url = new URL(value.trim());
      return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }
  function selectFile(event: Event) {
    const element = event.target as HTMLInputElement;
    const file = element.files?.[0];
    if (file) void client.sendFile(file);
    element.value = '';
  }
  async function acceptFile() {
    const id = view.incoming?.id;
    if (!id) return;
    await client.acceptFile();
    await tick();
    // Follow the explicit receive action to its progress/save controls. Incoming
    // offers alone never steal focus or scroll the page while someone is typing.
    const entry = document.getElementById('entry-' + id);
    entry?.focus({ preventScroll: true });
    entry?.scrollIntoView({
      block: 'nearest',
      behavior: prefersReducedMotion.current ? 'instant' : 'smooth',
    });
  }
  function drop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    if (event.dataTransfer && event.dataTransfer.files.length > 1) {
      flash(t('oneFile'));
      return;
    }
    if (available && !view.outgoing && event.dataTransfer?.files[0])
      void client.sendFile(event.dataTransfer.files[0]);
  }
</script>

<svelte:head><title>Textrans — {t('tagline')}</title></svelte:head>

{#snippet errorBanner()}
  <div class="error-banner" role="alert">
    <Icon name="alert" size={18} /><span>{errorText(language, view.error)}</span>
    <button class="icon-button" onclick={() => client.clearError()} aria-label={t('clear')}
      ><Icon name="close" size={16} /></button
    >
  </div>
{/snippet}

{#snippet copyLabel(id: string, label: CopyKey, icon: 'copy' | 'link')}
  <Icon name={copied === id ? 'check' : icon} size={15} />{t(copied === id ? 'copied' : label)}
{/snippet}

<a class="skip-link" href="#main">{t('skip')}</a>
<div class="page" class:in-session={!home}>
  <header class="bar">
    <a
      class="brand"
      href="/"
      onclick={(event) => {
        event.preventDefault();
        requestEnd();
      }}
      aria-label="Textrans">textrans</a
    >
    <span class="bar-meta"><span>{t('encrypted')}</span><span>{t('noStorage')}</span></span>
    <button
      class="language"
      onclick={() => {
        language = language === 'ja' ? 'en' : 'ja';
      }}
      aria-label={language === 'ja' ? 'Switch to English' : '日本語に切り替える'}
      >{language === 'ja' ? 'EN' : 'JA'}</button
    >
  </header>

  <main id="main" tabindex="-1">
    {#if home}
      <div class="home">
        <h1 class="home-title" tabindex="-1">{t('tagline')}</h1>
        <div class="panes">
          <section class="pane issue" aria-labelledby="issue-title" aria-busy={busy}>
            <h2 id="issue-title" class="kicker">{t('issueLabel')}</h2>
            {#if hosting && view.connection}
              <strong class="invite-code" id="invite-code" tabindex="-1" data-testid="invite-code"
                ><span>{view.connection.code.slice(0, 3)}</span><span
                  >{view.connection.code.slice(3)}</span
                ></strong
              >
              <div class="invite-body">
                <div class="qr" class:collapsed={!showQr}>
                  {#if qr}<img src={qr} width="144" height="144" alt={t('qrAlt')} />{:else}<span
                      class="spinner"
                      aria-hidden="true"
                    ></span>{/if}
                </div>
                <div class="invite-timer">
                  <p>{t('scanHelp')}</p>
                  <div class="meter" aria-hidden="true">
                    <i style:width={(view.remaining / (INVITE_TTL / 1000)) * 100 + '%'}></i>
                  </div>
                  <span class="mono" class:expiring={view.remaining < 30}
                    >{t('expires')} {clock(view.remaining)}</span
                  >
                </div>
              </div>
              <div class="actions">
                <button class="button" onclick={() => copy(view.connection!.code, 'code')}
                  >{@render copyLabel('code', 'copyCode', 'copy')}</button
                >
                <button class="button" onclick={() => copy(view.inviteUrl, 'invite')}
                  >{@render copyLabel('invite', 'link', 'link')}</button
                >
                <button
                  class="button qr-toggle"
                  aria-expanded={showQr}
                  onclick={() => {
                    showQr = !showQr;
                  }}><Icon name="qr" size={15} />{t(showQr ? 'hideQr' : 'showQr')}</button
                >
                <button class="button quiet" onclick={end}>{t('cancel')}</button>
              </div>
              <p class="hint">{t('pairTrust')}</p>
            {:else}
              <p class="hint">{t('issueHelp')}</p>
              <div class="actions">
                <button class="button primary" disabled={busy} onclick={create}
                  >{#if busy && action === 'create'}<span class="spinner small" aria-hidden="true"
                    ></span>{t('working')}{:else}{t('createButton')}{/if}</button
                >
              </div>
            {/if}
            {#if view.error && action === 'create'}{@render errorBanner()}{/if}
          </section>

          <section class="pane join" aria-labelledby="join-title">
            <h2 id="join-title" class="kicker">{t('joinLabel')}</h2>
            <form
              onsubmit={(event) => {
                event.preventDefault();
                join();
              }}
            >
              <label for="join-code" class="sr-only">{t('codeLabel')}</label>
              <div class="code-field">
                <input
                  id="join-code"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  pattern={'[0-9]{6}'}
                  value={code}
                  onfocus={() => {
                    codeFocused = true;
                  }}
                  onblur={() => {
                    codeFocused = false;
                  }}
                  oninput={(event) => {
                    code = event.currentTarget.value
                      .normalize('NFKC')
                      .replace(/\D/g, '')
                      .slice(0, 6);
                    event.currentTarget.value = code;
                    if (view.error) client.clearError();
                  }}
                  required
                  aria-invalid={!!view.error && action === 'join'}
                  aria-describedby="join-code-help"
                />
                <div class="code-boxes" aria-hidden="true">
                  {#each { length: 6 } as _, i}<span
                      class:filled={i < code.length}
                      class:current={codeFocused && i === Math.min(code.length, 5)}
                      >{code[i] ?? ''}</span
                    >{/each}
                </div>
              </div>
              <p id="join-code-help" class="hint">{t('joinHelp')}</p>
              <div class="actions">
                <button class="button primary" disabled={code.length !== 6 || busy}
                  >{#if busy && action === 'join'}<span class="spinner small" aria-hidden="true"
                    ></span>{t('working')}{:else}{t('joinButton')}<kbd aria-hidden="true">↵</kbd
                    >{/if}</button
                >
              </div>
            </form>
            <p class="hint camera-hint">{t('cameraHint')}</p>
            {#if view.error && action === 'join'}{@render errorBanner()}{/if}
          </section>
        </div>
      </div>
    {:else}
      <div class="session" class:wide={secure}>
        <div class="status-bar">
          <span
            class="status"
            class:ok={available}
            class:warn={view.phase === 'verifying' || view.phase === 'reconnecting'}
            aria-live="polite">{t(statusKey)}</span
          >
          {#if view.phase !== 'ended'}<button class="button quiet" onclick={requestEnd}
              >{t(secure ? 'end' : 'cancel')}</button
            >{/if}
        </div>
        {#if view.error && view.phase !== 'ended'}{@render errorBanner()}{/if}

        {#if view.phase === 'verifying' && !secure}
          <section class="panel verify" in:fade={{ duration: 140 }}>
            <h1 tabindex="-1">{t('verifying')}</h1>
            <div class="sas" data-testid="sas">
              {#each view.sas.split(' · ') as group}<span>{group}</span>{/each}
            </div>
            <p class="hint">{t('verifyHelp')}</p>
            <div class="verify-actions">
              {#if view.verified}<p class="waiting" role="status">
                  <span class="spinner small" aria-hidden="true"></span>{t('verifyWaiting')}
                </p>{:else}<button class="button primary" onclick={() => client.verify()}
                  >{t('verify')}</button
                >{/if}
              <button class="button" onclick={end}>{t('reject')}</button>
            </div>
          </section>
        {:else if secure}
          {#if view.phase === 'reconnecting'}<div class="connection-note" role="status">
              <span class="spinner small" aria-hidden="true"></span>
              <p>{t('reconnectHelp')}</p>
            </div>{/if}
          <div class="workspace">
            <section
              class="composer"
              class:dragging
              aria-labelledby="compose-title"
              ondragover={(event) => {
                event.preventDefault();
                if (available && !view.outgoing) dragging = true;
              }}
              ondragleave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) dragging = false;
              }}
              ondrop={drop}
            >
              <div class="composer-head">
                <h1 id="compose-title" class="kicker" tabindex="-1">{t('ready')}</h1>
                <button class="button quiet small" onclick={paste}
                  ><Icon name="paste" size={14} />{t('paste')}</button
                >
              </div>
              <label for="text-draft" class="sr-only">{t('compose')}</label>
              <div class="editor" class:over={textBytes > MAX_TEXT_BYTES}>
                <textarea
                  id="text-draft"
                  bind:this={textArea}
                  bind:value={draft}
                  placeholder={t('placeholder')}
                  aria-invalid={textBytes > MAX_TEXT_BYTES}
                  aria-describedby={textBytes > MAX_TEXT_BYTES ? 'text-limit-error' : undefined}
                  onkeydown={(event) => {
                    if (
                      (event.metaKey || event.ctrlKey) &&
                      event.key === 'Enter' &&
                      !event.isComposing
                    ) {
                      event.preventDefault();
                      void send();
                    }
                  }}></textarea>
                <div class="editor-meta mono">
                  <span class="shortcut">{t('shortcut')}</span><span
                    >{size(textBytes)} / 64 KiB</span
                  >
                </div>
              </div>
              {#if textBytes > MAX_TEXT_BYTES}<p
                  class="field-error"
                  id="text-limit-error"
                  role="alert"
                >
                  {t('text-too-large')}
                </p>{/if}
              <input
                bind:this={fileInput}
                type="file"
                onchange={selectFile}
                aria-label={t('file')}
                hidden
              />
              <div class="composer-actions">
                <button
                  class="button"
                  disabled={!available || view.outgoing}
                  onclick={() => fileInput?.click()}
                  ><Icon name={view.outgoing ? 'upload' : 'plus'} size={15} />{view.outgoing
                    ? t('fileBusy')
                    : t('file')}</button
                >
                <button class="button primary" disabled={!canSend} onclick={send}
                  >{t('send')}</button
                >
              </div>
              <p class="hint file-hint">{dragging ? t('dropNow') : t('fileHelp')}</p>
            </section>

            <section class="history" aria-labelledby="history-title">
              <div class="history-head">
                <h2 id="history-title" class="kicker">{t('history')}</h2>
                <span class="mono count">{view.history.length}</span>
              </div>
              {#if view.incoming}
                <article
                  class="entry request incoming-card"
                  aria-labelledby="incoming-title"
                  in:fade={{ duration: 140 }}
                >
                  <div class="entry-meta mono">
                    <span id="incoming-title" role="status">{t('incoming')}</span><span
                      >{size(view.incoming.size)}</span
                    >
                  </div>
                  <p class="file-name">{view.incoming.name}</p>
                  <div class="entry-actions">
                    <button class="button primary small" disabled={!available} onclick={acceptFile}
                      >{t('accept')}</button
                    ><button
                      class="button small"
                      onclick={() => client.cancelFile(view.incoming!.id)}>{t('decline')}</button
                    >
                  </div>
                </article>
              {/if}
              {#if !view.history.length && !view.incoming}<div class="empty">
                  <p class="empty-title">{t('emptyTitle')}</p>
                  <p class="hint">{t('empty')}</p>
                </div>{/if}
              {#each view.history as entry (entry.id)}
                {#if !(entry.id === view.incoming?.id && entry.status === 'offered')}
                  <article
                    class="entry"
                    id={'entry-' + entry.id}
                    tabindex="-1"
                    data-testid="history-entry"
                    in:fade={{ duration: 140 }}
                  >
                    <div class="entry-meta mono">
                      <span
                        >{t(entry.direction === 'out' ? 'you' : 'peer')} · {entry.kind === 'file'
                          ? t('fileKind') + ' · ' + size(entry.size || 0)
                          : t('text')}</span
                      >
                      <span class="delivery-status" class:complete={entry.status === 'delivered'}
                        >{t(
                          entry.status === 'delivered' && entry.direction === 'in'
                            ? 'received'
                            : entry.status,
                        )}{entry.status === 'transferring'
                          ? ' ' + Math.round((entry.progress || 0) * 100) + '%'
                          : ''}</span
                      >
                    </div>
                    {#if entry.kind === 'text'}<pre
                        class="received-text">{entry.text}</pre>{:else}<p class="file-name">
                        {entry.name}
                      </p>{/if}
                    {#if entry.status === 'transferring'}<progress
                        max="1"
                        value={entry.progress || 0}
                        aria-label={t('transferring')}
                      ></progress>{/if}
                    {#if entry.kind === 'text' || entry.url || (entry.kind === 'file' && ['offered', 'transferring'].includes(entry.status))}
                      <div class="entry-actions">
                        {#if entry.kind === 'text'}<button
                            class="button small"
                            onclick={() => copy(entry.text!, entry.id)}
                            >{@render copyLabel(entry.id, 'copy', 'copy')}</button
                          >{#if urlOf(entry.text!)}<a
                              class="button small"
                              href={urlOf(entry.text!)!}
                              target="_blank"
                              rel="noopener noreferrer"
                              ><Icon name="external" size={14} />{t('open')}</a
                            >{/if}{/if}
                        {#if entry.url}<a
                            class="button small primary"
                            href={entry.url}
                            download={entry.name}><Icon name="download" size={14} />{t('save')}</a
                          >{/if}
                        {#if entry.kind === 'file' && ['offered', 'transferring'].includes(entry.status)}<button
                            class="button small quiet"
                            onclick={() => client.cancelFile(entry.id)}>{t('cancel')}</button
                          >{/if}
                      </div>
                    {/if}
                  </article>
                {/if}
              {/each}
              <p class="hint history-note">{t('localHistory')}</p>
            </section>
          </div>
        {:else if view.phase === 'ended'}
          <section class="panel" in:fade={{ duration: 140 }}>
            <h1 tabindex="-1">{t('ended')}</h1>
            <p class="hint">
              {view.error === 'ended' ? t('endedHelp') : errorText(language, view.error)}
            </p>
            {#each view.history as entry}<article class="entry">
                <div class="entry-meta mono"><span>{t('unsent')}</span></div>
                <pre class="received-text">{entry.text}</pre>
                <div class="entry-actions">
                  <button class="button small" onclick={() => copy(entry.text!, entry.id)}
                    >{@render copyLabel(entry.id, 'copy', 'copy')}</button
                  >
                </div>
              </article>{/each}
            {#if draft}<article class="entry">
                <div class="entry-meta mono"><span>{t('unsent')}</span></div>
                <pre class="received-text">{draft}</pre>
                <div class="entry-actions">
                  <button class="button small" onclick={() => copy(draft, 'draft')}
                    >{@render copyLabel('draft', 'copy', 'copy')}</button
                  >
                </div>
              </article>{/if}
            <div class="verify-actions">
              <button class="button primary" onclick={requestEnd}>{t('again')}</button>
            </div>
          </section>
        {:else}<section class="panel">
            <span class="spinner" aria-hidden="true"></span>
            <h1 tabindex="-1">{t('working')}</h1>
            <p class="hint">{t('footer')}</p>
          </section>{/if}
      </div>
    {/if}
  </main>
  <footer class="footer">
    <span class="mono">{t('limits')} · {t('sessionLimit')}</span>
    <span>{t('footer')}</span>
    <details>
      <summary>{t('privacy')}</summary>
      <p>{t('privacyText')}</p>
    </details>
  </footer>
</div>

<dialog
  bind:this={endDialog}
  class="end-dialog"
  aria-labelledby="end-title"
  aria-describedby="end-description"
>
  <h2 id="end-title">{t('endTitle')}</h2>
  <p id="end-description">{t('endHelp')}</p>
  <div class="dialog-actions">
    <button class="button" onclick={() => endDialog?.close()}>{t('keepConnection')}</button><button
      class="button danger"
      onclick={end}>{t('endConfirm')}</button
    >
  </div>
</dialog>
{#if notice}<div
    class="toast"
    role="status"
    in:fade={{ duration: 120 }}
    out:fade={{ duration: 120 }}
  >
    <Icon name={notice === t('copied') ? 'check' : 'alert'} size={16} />{notice}
  </div>{/if}
