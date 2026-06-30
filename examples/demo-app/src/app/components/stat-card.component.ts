import { Component, input } from '@angular/core';

@Component({
  selector: 'app-stat-card',
  standalone: true,
  template: `<div class="card"><span>{{ label() }}</span><strong>{{ value() }}</strong></div>`,
})
export class StatCardComponent {
  label = input.required<string>();
  value = input.required<number>();
}
