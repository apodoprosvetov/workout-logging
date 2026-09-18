import { Controller, Get, UseGuards } from '@nestjs/common';

import { ExercisesService } from './exercises.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('exercises')
@UseGuards(JwtAuthGuard)
export class ExercisesController {
  constructor(private readonly exercisesService: ExercisesService) {}

  // Read-only, and the same for every caller: the catalog is reference data,
  // not user data. Creating an entry is deliberately not exposed.
  @Get()
  async list() {
    return this.exercisesService.list();
  }
}
