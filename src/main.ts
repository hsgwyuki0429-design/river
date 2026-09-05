if (new URLSearchParams(location.search).get('mode') === 'sandbox') {
  void import('./legacy-main.ts');
} else {
  void import('./observatory/app.ts');
}
