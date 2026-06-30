import { Component, inject } from '@angular/core';
import { Dialog } from '@angular/cdk/dialog';
import { StatusBadgeComponent } from '../../components/status-badge.component';
import { EmptyStateComponent } from '../../components/empty-state.component';
import { ConfirmDialogComponent } from '../../components/confirm-dialog.component';

@Component({
  selector: 'app-order-list-page',
  standalone: true,
  imports: [StatusBadgeComponent, EmptyStateComponent],
  template: `
    @for (o of orders; track o.id) {
      <span>{{ o.id }}</span> <app-status-badge [status]="o.status" />
      <button (click)="cancel(o.id)">Cancel</button>
    } @empty {
      <app-empty-state message="No orders" />
    }
  `,
})
export class OrderListPageComponent {
  private dialog = inject(Dialog);
  orders: { id: string; status: 'open' | 'paid' | 'cancelled' }[] = [];

  cancel(id: string) {
    // ConfirmDialogComponent is opened here, not used in a template — so the tool
    // classifies it as a 🟪 dialog (normal), not a suspect.
    this.dialog.open(ConfirmDialogComponent);
  }
}
