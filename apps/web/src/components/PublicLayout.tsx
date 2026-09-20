import { Outlet } from 'react-router-dom';
import SiteHeader from './SiteHeader';

/** 公共页面共享布局：切换兑换/取件时保留顶部导航与在线状态。 */
export default function PublicLayout() {
  return (
    <div className="page">
      <SiteHeader />
      <Outlet />
    </div>
  );
}
