import { ArrayNotEmpty, IsArray, IsInt, Min } from 'class-validator';

export class PresignPartsDto {
  /** 1-based part numbers to presign for direct upload to storage. */
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Min(1, { each: true })
  partNumbers: number[];
}
