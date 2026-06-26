/**
 * Repositories barrel — re-exports the factory functions and default singleton
 * repository objects for customers, orders, and policies.
 *
 * Import from this file to avoid deep relative paths:
 *
 * ```ts
 * import { customerRepository, orderRepository, policyRepository } from '../repositories/index.js';
 * // or, for dependency injection:
 * import { createOrderRepository } from '../repositories/index.js';
 * ```
 *
 * _Requirements: 12.8, 6.1, 6.2, 5.1_
 */

export {
  createCustomerRepository,
  customerRepository,
} from './customerRepository.js';

export {
  createOrderRepository,
  orderRepository,
} from './orderRepository.js';

export {
  createPolicyRepository,
  policyRepository,
} from './policyRepository.js';
