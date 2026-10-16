import { Body, Controller, Post, ConflictException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { FinancialTransactionDto, FinancialReversalDto } from './financial-transaction.dto.js';
import { ProcessBetUseCase } from '../../application/use-cases/process-bet.use-case.js';
import { ProcessWinUseCase } from '../../application/use-cases/process-win.use-case.js';
import { ProcessLossUseCase } from '../../application/use-cases/process-loss.use-case.js';
import { ProcessRefundUseCase } from '../../application/use-cases/process-refund.use-case.js';
import { ProcessRollbackUseCase } from '../../application/use-cases/process-rollback.use-case.js';
import { calculateFinancialPayloadHash } from './financial-payload-hash.js';

@Controller('transactions')
export class FinancialController {
  constructor(
    private readonly em: EntityManager,
  ) {}

  @Post('bet')
  async bet(@Body() input: FinancialTransactionDto) {
    const useCase = new ProcessBetUseCase(
      this.em.fork(),
    );

    return useCase.execute({
      ...input,
      payloadHash: calculateFinancialPayloadHash('BET', input),
    });
  }

  @Post('win')
  async win(@Body() input: FinancialTransactionDto) {
    const useCase = new ProcessWinUseCase(
      this.em.fork(),
    );

    return useCase.execute({
      ...input,
      payloadHash: calculateFinancialPayloadHash('WIN', input),
    });
  }

  @Post('loss')
  async loss(@Body() input: FinancialTransactionDto) {
    const useCase = new ProcessLossUseCase(
      this.em.fork(),
    );

    return useCase.execute({
      ...input,
      payloadHash: calculateFinancialPayloadHash('LOSS', input),
    });
  }

  
  @Post('refund')
  async refund(@Body() input: FinancialReversalDto) {
    const useCase = new ProcessRefundUseCase(
      this.em.fork(),
    );

    try {
      return await useCase.execute({
        ...input,
        payloadHash: calculateFinancialPayloadHash('REFUND', input),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'REFUND_ALREADY_EXISTS'
      ) {
        throw new ConflictException(
          'REFUND_ALREADY_EXISTS',
        );
      }

      throw error;
    }
  }

  
  @Post('rollback')
  async rollback(@Body() input: FinancialReversalDto) {
    const useCase = new ProcessRollbackUseCase(
      this.em.fork(),
    );

    try {
      return await useCase.execute({
        ...input,
        payloadHash: calculateFinancialPayloadHash('ROLLBACK', input),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'ROLLBACK_ALREADY_EXISTS'
      ) {
        throw new ConflictException(
          'ROLLBACK_ALREADY_EXISTS',
        );
      }

      throw error;
    }
  }

}