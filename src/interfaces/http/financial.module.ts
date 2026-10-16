
import { Module } from '@nestjs/common';

import { FinancialController } from './financial.controller';

@Module({
  controllers: [FinancialController],
})
export class FinancialModule {}