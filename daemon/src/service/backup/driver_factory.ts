import {
  BackupDriverError,
  BackupDriverErrorCode,
  DestinationDriver,
  DestinationDriverFactory,
  PlainBackupDestination
} from "mcsmanager-common";
import { createGDriveDriver } from "./destinations/gdrive";
import { createLocalDriver } from "./destinations/local";
import { createS3Driver } from "./destinations/s3";

/** Builds the driver for a destination of any type. One driver per destination per job. */
export const createDestinationDriver: DestinationDriverFactory = (
  destination: PlainBackupDestination
): DestinationDriver => {
  switch (destination.type) {
    case "local":
      return createLocalDriver(destination);
    case "s3":
      return createS3Driver(destination);
    case "gdrive":
      return createGDriveDriver(destination);
    default:
      throw new BackupDriverError(BackupDriverErrorCode.FAILED, "Unknown destination type");
  }
};
