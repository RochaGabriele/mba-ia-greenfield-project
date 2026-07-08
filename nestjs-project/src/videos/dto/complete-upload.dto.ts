import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class UploadPartDto {
  /** 1-based part number, matching the presigned part that was uploaded. */
  @IsInt()
  @Min(1)
  partNumber: number;

  /** ETag returned by storage for the uploaded part. */
  @IsString()
  @IsNotEmpty()
  eTag: string;
}

export class CompleteUploadDto {
  /** The uploaded parts (partNumber + eTag) used to assemble the final object. */
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => UploadPartDto)
  parts: UploadPartDto[];
}
