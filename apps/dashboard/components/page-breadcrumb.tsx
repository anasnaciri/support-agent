import { Fragment } from "react";
import Link from "next/link";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

interface BreadcrumbLinkItem {
  readonly href: string;
  readonly label: string;
}

interface PageBreadcrumbProps {
  readonly items?: ReadonlyArray<BreadcrumbLinkItem>;
  readonly current: string;
}

/**
 * Top-level page breadcrumb: always rooted at the dashboard home, with the
 * current page as the trailing non-link crumb. `items` adds intermediate
 * links between Dashboard and the current page. Settings has its own
 * `SettingsBreadcrumb`, built on the same primitives.
 */
export const PageBreadcrumb = ({
  items = [],
  current,
}: PageBreadcrumbProps) => (
  <Breadcrumb>
    <BreadcrumbList>
      <BreadcrumbItem>
        <BreadcrumbLink asChild>
          <Link href="/">Dashboard</Link>
        </BreadcrumbLink>
      </BreadcrumbItem>
      {items.map((item) => (
        <Fragment key={item.href}>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href={item.href}>{item.label}</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
        </Fragment>
      ))}
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbPage>{current}</BreadcrumbPage>
      </BreadcrumbItem>
    </BreadcrumbList>
  </Breadcrumb>
);
