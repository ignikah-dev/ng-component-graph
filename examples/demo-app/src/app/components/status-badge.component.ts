import { Component, input } from '@angular/core';

@Component({
  selector: 'app-status-badge',
  standalone: true,
  template: `<span class="badge" [class]="status()">{{ status() }}</span>`,
})
export class StatusBadgeComponent {
  status = input.required<'open' | 'paid' | 'cancelled'>();
}
