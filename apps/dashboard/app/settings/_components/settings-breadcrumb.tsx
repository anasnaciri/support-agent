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

interface SettingsBreadcrumbProps {
  readonly items?: ReadonlyArray<BreadcrumbLinkItem>;
  readonly current: string;
}

export const SettingsBreadcrumb = ({
  items = [],
  current,
}: SettingsBreadcrumbProps) => (
  <Breadcrumb>
    <BreadcrumbList>
      <BreadcrumbItem>
        <BreadcrumbLink asChild>
          <Link href="/">Dashboard</Link>
        </BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        {items.length === 0 && current === "Settings" ? (
          <BreadcrumbPage>Settings</BreadcrumbPage>
        ) : (
          <BreadcrumbLink asChild>
            <Link href="/settings">Settings</Link>
          </BreadcrumbLink>
        )}
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
      {items.length > 0 || current !== "Settings" ? (
        <>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{current}</BreadcrumbPage>
          </BreadcrumbItem>
        </>
      ) : null}
    </BreadcrumbList>
  </Breadcrumb>
);
