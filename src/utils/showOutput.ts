import { Logger } from './logger';

export function showOutputMessage(message: string): void {
    const logger = Logger.getInstance();
    logger.info(message);
    logger.show();
}