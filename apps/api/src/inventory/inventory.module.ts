import { Module } from "@nestjs/common";

import { InventoryReservationService } from "./inventory-reservation.service";

@Module({
  providers: [InventoryReservationService],
  exports: [InventoryReservationService],
})
export class InventoryModule {}
