import { Component } from '@angular/core';
import { StatCardComponent } from '../../components/stat-card.component';
import { EmptyStateComponent } from '../../components/empty-state.component';

@Component({
  selector: 'app-dashboard-page',
  standalone: true,
  imports: [StatCardComponent, EmptyStateComponent],
  template: `
    <app-stat-card label="Orders" [value]="42" />
    <app-stat-card label="Revenue" [value]="1280" />
    @if (empty) { <app-empty-state message="No activity today" /> }
  `,
})
export class DashboardPageComponent {
  empty = false;
}
