// @vitest-environment jsdom

import { cleanup, render } from '../ui/test-support/react-testing';
import { afterEach, describe, expect, it } from 'vitest';
import Trend from '../ui/src/components/panels/Trend';

describe('legacy trend population', () => {
  afterEach(cleanup);

  it('renders one row for every supplied iteration without truncating a large collection', () => {
    const iterations = Array.from({ length: 55 }, (_, index) => ({
      label: `iteration-${index}`,
      value: index,
    }));

    const rendered = render(<Trend campaign={{ iterations }} />);

    expect(rendered.container.querySelectorAll('.trend-row')).toHaveLength(iterations.length);
  });
});
