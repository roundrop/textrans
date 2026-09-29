<script lang="ts">
  export type IconName =
    | 'arrows'
    | 'arrow'
    | 'back'
    | 'lock'
    | 'check'
    | 'copy'
    | 'link'
    | 'file'
    | 'download'
    | 'upload'
    | 'close'
    | 'plus'
    | 'globe'
    | 'shield'
    | 'clock'
    | 'inbox'
    | 'text'
    | 'alert'
    | 'qr'
    | 'paste'
    | 'external';
  let { name, size = 20 }: { name: IconName; size?: number } = $props();
  const paths: Record<IconName, string> = {
    arrows: 'M4 8h16m-4-4 4 4-4 4M20 16H4m4-4-4 4 4 4',
    arrow: 'M5 12h14m-6-6 6 6-6 6',
    back: 'M15 5l-7 7 7 7',
    lock: 'M7 10V7a5 5 0 0 1 10 0v3M6 10h12a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Zm6 4v3',
    check: 'm5 12 4 4L19 6',
    copy: 'M9 8h10a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1ZM15 4V3H4v13h1',
    link: 'm10 13 4-4m-6 6-1 1a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0m2 2 1-1a3.5 3.5 0 0 1 5 5l-4 4a3.5 3.5 0 0 1-5 0',
    file: 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Zm0 0v5h5M9 13h6m-6 4h4',
    download: 'M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4',
    upload: 'M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4',
    close: 'm6 6 12 12M6 18 18 6',
    plus: 'M12 5v14M5 12h14',
    globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z',
    shield: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Zm-4 9 3 3 5-6',
    clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2',
    inbox: 'm4 5-2 9v5h20v-5l-2-9H4Zm-2 9h6l2 3h4l2-3h6',
    text: 'M5 5h14M12 5v15m-4 0h8',
    alert: 'M12 3 2 21h20L12 3Zm0 6v5m0 3v.5',
    qr: 'M3 3h6v6H3V3Zm12 0h6v6h-6V3ZM3 15h6v6H3v-6Zm12 0h3v3h3v3h-6v-6Z',
    paste: 'M9 4H5v17h14V4h-4M9 2h6v5H9V2Zm0 10h6m-6 4h4',
    external: 'M14 3h7v7m0-7L10 14m0-10H3v17h17v-7',
  };
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.7"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"><path d={paths[name]} /></svg
>
