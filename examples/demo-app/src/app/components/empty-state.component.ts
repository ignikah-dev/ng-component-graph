import { Component, input } from '@angular/core';

@Component({
  selector: 'app-empty-state',
  standalone: true,
  template: `<p class="empty">{{ message() }}</p>`,
})
export class EmptyStateComponent {
  message = input('Nothing here yet');
}
