import { Component } from '@angular/core';

// NOTE: this component is intentionally left unused — it demonstrates a 🟥 "suspect"
// node: not in any template's imports[], not route-mounted, not opened as a dialog.
@Component({
  selector: 'app-legacy-banner',
  standalone: true,
  template: `<div class="legacy">Old promo banner</div>`,
})
export class LegacyBannerComponent {}
